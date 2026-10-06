import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIMessage, AIRequest, RetryPolicy, RoutingPolicy, RoutingTarget, TimeoutConfig } from '@core/types'
import type { CompactionEvent, CompactionResult, Conversation } from '@shared/ipc'
import { pruneStartsAt, resolveCompactionPolicy } from '@shared/contextPolicy'
import { countUserTurns, pruneToolResults, shouldAutoCompact } from './compaction'
import { selectContext } from './contextHistory'
import { ContextAnchorStore } from './contextAnchor'
import { effectiveContextWindow, estimateContextUsage } from './contextUsage'
import { compactConversation, type CompactorDeps } from './conversationCompactor'

/**
 * The runtime side of compaction: when to compact, with which model, and the
 * guards around it. ChatService owns an instance and only wires it in, so the
 * agent loop keeps a handful of call sites.
 */

/** What the coordinator needs from the application, so it can be tested without any of it. */
export interface CompactionHost {
  repo: CompactorDeps['repo']
  /** The gateway's non-streaming call, with its usage recorded. */
  send: CompactorDeps['send']
  modelInfo(providerId: string, model: string): { contextWindow?: number; longContextBeta?: boolean } | undefined
  /** True while a turn of this task is generating. */
  isRunning(conversationId: string): boolean
  /** Why a request for this task must not go out now (a spending cap set to stop), or undefined when it may. */
  budgetBlock?(conversationId: string, target: RoutingTarget): string | undefined
  /** Read per call, so a change in Settings applies from the next request. */
  settings(): { ai?: { autoCompact?: unknown; compaction?: unknown; retry?: RetryPolicy; timeout?: TimeoutConfig } } | undefined
  /** The task's stored history as model messages, as the next request would carry it. */
  loadHistory(conversationId: string): AIMessage[]
  warn(message: string): void
}

export interface AutoCompaction {
  /** True once a compaction was tried this turn, successful or not: never try twice. */
  attempted: boolean
  compacted?: {
    summary: string
    boundaryMessageId: string
    /** The stored-history part of the next request, rebuilt around the new boundary. */
    history?: AIMessage[]
  }
}

/** Old tool output that was replaced with stubs, and the event that tells the thread about it. */
export interface PruneOutcome {
  messages: AIMessage[]
  event: CompactionEvent
}

const fail = (error: string): CompactionResult => ({ ok: false, error })
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const LONG_CONTEXT_HEADER = 'x-cubex-long-context'

export class CompactionCoordinator {
  /** Tasks being compacted by hand right now. */
  private readonly compacting = new Set<string>()
  /** Routing of each task's latest turn: what a manual compaction summarizes with. */
  private readonly lastPolicies = new Map<string, RoutingPolicy>()

  constructor(
    private readonly host: CompactionHost,
    /** Shared with ChatService, which records a report from every response. */
    private readonly anchor: ContextAnchorStore = new ContextAnchorStore()
  ) {}

  isCompacting(conversationId: string): boolean {
    return this.compacting.has(conversationId)
  }

  rememberPolicy(conversationId: string, policy: RoutingPolicy): void {
    this.lastPolicies.set(conversationId, policy)
  }

  forget(conversationId: string): void {
    this.lastPolicies.delete(conversationId)
    this.anchor.forget(conversationId)
  }

  /** The model the task was last used with; the stored one only until its first turn after a restart. */
  private policyFor(conversation: Conversation): RoutingPolicy | undefined {
    const last = this.lastPolicies.get(conversation.id)
    if (last) return last
    if (!conversation.providerId || !conversation.model) return undefined
    const ai = this.host.settings()?.ai
    return {
      primary: { providerId: conversation.providerId, model: conversation.model },
      fallbacks: [], fallbackEnabled: false,
      retry: ai?.retry ?? DEFAULT_RETRY_POLICY, timeout: ai?.timeout ?? {}
    }
  }

  /**
   * The request as it will be sent: the target's sampling parameters, and so its output cap, included. The
   * context meter counts it this way, so the trigger and the tick drawn at it use the same budget.
   */
  private asSent(request: AIRequest, policy: RoutingPolicy): AIRequest {
    const params = policy.primary.params
    return params ? { ...request, params: { ...request.params, ...params } } : request
  }

  /** The /compact command: summarize older turns now. A failed summary changes nothing. */
  async compact(conversationId: string): Promise<CompactionResult> {
    if (this.host.isRunning(conversationId)) return fail('Stop the running turn before compacting this task.')
    if (this.compacting.has(conversationId)) return fail('This task is already being compacted.')
    const conversation = this.host.repo.get(conversationId)
    if (!conversation) return fail('Conversation not found.')
    const policy = this.policyFor(conversation)
    if (!policy) return fail('Choose a model for this task before compacting it.')
    // The summary is a paid request like any other, so a cap set to stop applies to it too.
    const blocked = this.host.budgetBlock?.(conversationId, policy.primary)
    if (blocked) return fail(blocked)
    this.compacting.add(conversationId)
    try {
      const contextWindow = effectiveContextWindow(this.host.modelInfo(policy.primary.providerId, policy.primary.model), false)
      const { threshold } = resolveCompactionPolicy(this.host.settings()?.ai)
      return await compactConversation(this.host, conversationId, { policy, threshold, ...(contextWindow !== undefined ? { contextWindow } : {}) })
    } finally {
      this.compacting.delete(conversationId)
    }
  }

  /**
   * Before a request: when it has reached the summarizing threshold (80 percent of the input budget unless
   * Settings says otherwise) and the task has at least three user turns, summarize the older ones. The caller
   * tries this once per turn. Progress is reported through `onProgress`: started once there is something to
   * summarize, then completed or failed. Never throws: a failed summary is logged and the turn carries on
   * with the full context.
   */
  async auto(
    conversationId: string,
    request: AIRequest,
    policy: RoutingPolicy,
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
    onProgress?: (event: CompactionEvent) => void
  ): Promise<AutoCompaction> {
    // A summary that began is reported; a plan that found nothing to summarize is not an event worth showing.
    let started = false
    const failed = (error: string): AutoCompaction => {
      this.host.warn(`Automatic compaction ${started ? 'failed' : 'skipped'}: ${error}`)
      if (started) onProgress?.({ step: 'summarize', phase: 'failed', error })
      return { attempted: true }
    }
    try {
      const { auto: enabled, threshold } = resolveCompactionPolicy(this.host.settings()?.ai)
      // Same window rule as the context snapshot: a gated 1M model counts as 200K until opted in.
      const contextWindow = effectiveContextWindow(
        this.host.modelInfo(policy.primary.providerId, policy.primary.model), headers?.[LONG_CONTEXT_HEADER] === '1'
      )
      // Anchored on the provider's last reported input count, so the decision
      // rests on a measurement plus the little that was appended after it.
      const snapshot = enabled && contextWindow ? estimateContextUsage(this.asSent(request, policy), { contextWindow }) : undefined
      const estimatedTokens = snapshot ? this.anchor.resolve(conversationId, snapshot.estimatedTokens).tokens : 0
      const maxOutputTokens = snapshot?.outputReserveKnown ? snapshot.outputReserve : undefined
      const due = (userTurns: number): boolean =>
        shouldAutoCompact({ enabled, contextWindow, estimatedTokens, userTurns, alreadyCompacted: false, maxOutputTokens, threshold })
      // The stored task is only read once the request is large enough to matter.
      if (this.compacting.has(conversationId) || !due(Number.MAX_SAFE_INTEGER)) return { attempted: false }
      const stored = this.host.repo.get(conversationId)
      if (!stored || !due(countUserTurns(selectContext(stored.messages, stored.contextStartMessageId).messages))) return { attempted: false }

      const result = await compactConversation(this.host, conversationId, {
        policy, contextWindow: contextWindow!, estimatedTokens, threshold, signal, ...(headers ? { headers } : {}),
        onPlan: ({ messagesSummarized }) => {
          started = true
          onProgress?.({ step: 'summarize', phase: 'started', messagesSummarized })
        }
      })
      if (!result.ok) return failed(result.error)
      // The anchored report describes a conversation that no longer exists.
      this.anchor.forget(conversationId)
      onProgress?.({
        step: 'summarize', phase: 'completed', summary: result.summary, boundaryMessageId: result.boundaryMessageId,
        ...(result.messagesSummarized !== undefined ? { messagesSummarized: result.messagesSummarized } : {}),
        ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
        ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {})
      })
      let history: AIMessage[] | undefined
      try {
        history = this.host.loadHistory(conversationId)
      } catch (error) {
        // The summary is saved; this request just keeps the messages it already has.
        this.host.warn(`Could not reload history after compaction: ${describe(error)}`)
      }
      return { attempted: true, compacted: { summary: result.summary, boundaryMessageId: result.boundaryMessageId, ...(history ? { history } : {}) } }
    } catch (error) {
      // Housekeeping must never end the user's turn.
      return failed(describe(error))
    }
  }

  /**
   * Before a request: once it has grown past the start of the pressure ladder (60 percent of the input
   * budget, and ten points below a lower summarizing threshold), replace the output of old tool calls with
   * short stubs. This is one step and not a little each time, because every edit to an old message
   * invalidates the provider's prompt cache; `pruneToolResults` also keeps the newest 40 000 tokens whole and
   * does nothing unless 20 000 would come back. Returns undefined when pruning is off or nothing was trimmed.
   */
  prune(
    conversationId: string,
    request: AIRequest,
    policy: RoutingPolicy,
    headers: Record<string, string> | undefined
  ): PruneOutcome | undefined {
    try {
      const { prune, threshold } = resolveCompactionPolicy(this.host.settings()?.ai)
      if (!prune) return undefined
      const contextWindow = effectiveContextWindow(
        this.host.modelInfo(policy.primary.providerId, policy.primary.model), headers?.[LONG_CONTEXT_HEADER] === '1'
      )
      if (!contextWindow) return undefined
      const snapshot = estimateContextUsage(this.asSent(request, policy), { contextWindow })
      const used = this.anchor.resolve(conversationId, snapshot.estimatedTokens).tokens
      if (used / (snapshot.inputBudget ?? contextWindow) < pruneStartsAt(threshold)) return undefined
      const pruned = pruneToolResults(request.messages)
      if (!pruned.prunedToolUseIds.length) return undefined
      return {
        messages: pruned.messages,
        event: { step: 'prune', phase: 'completed', resultsTrimmed: pruned.prunedToolUseIds.length, tokensFreed: pruned.reclaimedTokens }
      }
    } catch (error) {
      // Housekeeping must never end the user's turn.
      this.host.warn(`Pruning old tool output failed: ${describe(error)}`)
      return undefined
    }
  }
}
