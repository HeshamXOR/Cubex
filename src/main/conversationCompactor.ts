import { NormalizedAIError } from '@core/types'
import type { AIRequest, AIResponse, RetryPolicy, RoutingPolicy, RoutingTarget } from '@core/types'
import type { CompactionResult, Conversation } from '@shared/ipc'
import { buildSummaryRequest, cleanSummary, planCompaction, summaryTokenSaving } from './compaction'
import { selectContext } from './contextHistory'

/**
 * Orchestrates one compaction: plan a boundary, ask a model for the summary,
 * then store both together. Used by the /compact command and by the automatic
 * trigger. A failure at any point leaves the conversation exactly as it was.
 */

/** A summary shorter than this is a refusal or an acknowledgement, not a record of the work. */
const MIN_SUMMARY_CHARS = 40
/** A summary is a side request: do not let it hold up the turn behind long retry chains. */
const MAX_SUMMARY_ATTEMPTS = 2

export interface CompactorDeps {
  repo: {
    get(id: string): Conversation | null
    update(id: string, patch: Partial<Conversation>): void
  }
  /** A non-streaming gateway call (`AIGateway.send`). */
  send(
    request: AIRequest,
    policy: RoutingPolicy,
    /** `conversationId` is for billing the summary to the task; the gateway never sees it. */
    options?: { signal?: AbortSignal; headers?: Record<string, string>; conversationId?: string }
  ): Promise<AIResponse>
  now?: () => number
}

export interface CompactOptions {
  /** Routing of the current work: its primary target writes the summary, its retry and timeout settings apply. */
  policy: RoutingPolicy
  /** The summarizing model's window, when known. Sizes the prompt. */
  contextWindow?: number
  /** Estimated input of the request about to be sent. Only the automatic trigger knows it. */
  estimatedTokens?: number
  keepRecentTurns?: number
  /** The summarizing threshold in effect, from Settings. */
  threshold?: number
  /** Called once a boundary is chosen and the summary is about to be requested; never when there is nothing to summarize. */
  onPlan?: (plan: { messagesSummarized: number }) => void
  signal?: AbortSignal
  headers?: Record<string, string>
}

const fail = (error: string): CompactionResult => ({ ok: false, error })
const CANCELLED = 'Compaction was cancelled.'
const CHANGED = 'The conversation changed while it was being compacted. Nothing was saved.'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The summary runs on the active model alone, with its own sampling and a short retry budget. */
function summaryPolicy(base: RoutingPolicy, maxOutputTokens: number): RoutingPolicy {
  const primary: RoutingTarget = {
    providerId: base.primary.providerId,
    model: base.primary.model,
    // Replaces, never merges with, the chat turn's output cap and reasoning effort.
    params: { maxOutputTokens, reasoningEffort: 'minimal' }
  }
  const retry: RetryPolicy = { ...base.retry, maxAttempts: Math.max(1, Math.min(base.retry.maxAttempts, MAX_SUMMARY_ATTEMPTS)) }
  return { primary, fallbacks: [], fallbackEnabled: false, retry, timeout: base.timeout }
}

async function compact(deps: CompactorDeps, conversationId: string, options: CompactOptions): Promise<CompactionResult> {
  if (options.signal?.aborted) return fail(CANCELLED)
  const conversation = deps.repo.get(conversationId)
  if (!conversation) return fail('Conversation not found.')

  // Only what the model currently sees is replanned; an earlier summary is folded in.
  const { messages: visible, summary: previous } = selectContext(
    conversation.messages, conversation.contextStartMessageId, conversation.contextSummary
  )
  const plan = planCompaction(visible, {
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
    ...(options.estimatedTokens !== undefined ? { estimatedTokens: options.estimatedTokens } : {}),
    ...(options.keepRecentTurns !== undefined ? { keepRecentTurns: options.keepRecentTurns } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {})
  })
  if (!plan) return fail('There is not enough earlier conversation to compact yet.')
  // The summary stands in for everything before the new boundary, including what an earlier summary covered.
  const messagesSummarized = conversation.messages.findIndex((message) => message.id === plan.boundaryMessageId)
  options.onPlan?.({ messagesSummarized })

  const prompt = buildSummaryRequest(plan.summarize, previous, options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {})
  const routing = summaryPolicy(options.policy, prompt.maxOutputTokens)
  const request: AIRequest = {
    model: routing.primary.model,
    system: prompt.system,
    messages: prompt.messages,
    params: routing.primary.params!,
    stream: false
  }

  let response: AIResponse
  try {
    response = await deps.send(request, routing, {
      conversationId,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {})
    })
  } catch (error) {
    if (options.signal?.aborted || (error instanceof NormalizedAIError && error.category === 'CANCELLED')) return fail(CANCELLED)
    return fail(`Could not summarize the conversation: ${describe(error)}`)
  }
  if (options.signal?.aborted) return fail(CANCELLED)
  if (response.stopReason === 'content_filter') return fail('The model declined to summarize this conversation.')

  const summary = cleanSummary(response.text, { cutOff: response.stopReason === 'length' })
  if (!summary) return fail('The model returned an empty summary.')
  if (summary.length < MIN_SUMMARY_CHARS) return fail('The model returned a summary that was too short to use.')

  // The call took a while; never write a boundary into a conversation that moved on meanwhile.
  const fresh = deps.repo.get(conversationId)
  if (!fresh) return fail('The conversation no longer exists.')
  if (
    fresh.contextStartMessageId !== conversation.contextStartMessageId ||
    fresh.contextSummary !== conversation.contextSummary ||
    !fresh.messages.some((message) => message.id === plan.boundaryMessageId && message.role === 'user')
  ) return fail(CHANGED)

  deps.repo.update(conversationId, {
    contextStartMessageId: plan.boundaryMessageId,
    contextSummary: summary,
    contextSummaryAt: (deps.now ?? Date.now)()
  })
  return { ok: true, summary, boundaryMessageId: plan.boundaryMessageId, messagesSummarized, ...summaryTokenSaving(plan.summarize, previous, summary) }
}

/** Never throws: every failure is a `{ ok: false, error }` the caller can show. */
export async function compactConversation(deps: CompactorDeps, conversationId: string, options: CompactOptions): Promise<CompactionResult> {
  try {
    return await compact(deps, conversationId, options)
  } catch (error) {
    return fail(`Could not compact the conversation: ${describe(error)}`)
  }
}
