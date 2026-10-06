/**
 * Gemini `GenerateContentResponse` chunks to normalized stream events. The same
 * mapper serves `streamGenerateContent` (one call per SSE frame) and the plain
 * `generateContent` response (one call), so both paths behave identically.
 *
 * Gemini thought signatures ride along as `metadata` events in the shape the
 * accumulator already understands (`reasoningBlock.signature`), emitted right
 * AFTER the part they sign: a signed summary closes its reasoning block, and a
 * signature after a function call or text becomes its own empty reasoning part
 * that translate.ts re-attaches to the part before it (see ./replay).
 */
import { NormalizedAIError } from '../../types/errors'
import type { StopReason, Usage } from '../../types/response'
import type { AIStreamEvent } from '../../types/stream'
import { geminiStopError, normalizeGeminiError, type GeminiSafetyRating } from './errors'
import { geminiCallId, packGeminiSignature } from './replay'

// --- Native wire shapes (the subset this adapter reads) ---

export interface GemResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name?: string; args?: unknown }
  [key: string]: unknown
}

export interface GemCandidate {
  content?: { role?: string; parts?: GemResponsePart[] }
  finishReason?: string
  finishMessage?: string
  safetyRatings?: GeminiSafetyRating[]
  index?: number
}

export interface GemUsage {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  toolUsePromptTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface GemChunk {
  candidates?: GemCandidate[]
  promptFeedback?: { blockReason?: string; safetyRatings?: GeminiSafetyRating[] }
  usageMetadata?: GemUsage
  modelVersion?: string
  responseId?: string
  /** An in-band failure: the stream was HTTP 200 and then broke. */
  error?: { code?: number; message?: string; status?: string; details?: unknown[] }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Gemini reports thoughts apart from candidates, but bills them as output, so the
 * unified `outputTokens` includes them (as OpenAI's does) and `reasoningTokens`
 * names the part that was thinking. Prompt tokens already include cached ones.
 */
export function mapGeminiUsage(usage: GemUsage | undefined): Usage | undefined {
  if (!usage) return undefined
  const out: Usage = {}
  const prompt = count(usage.promptTokenCount)
  const toolUse = count(usage.toolUsePromptTokenCount)
  if (prompt !== undefined || toolUse !== undefined) out.inputTokens = (prompt ?? 0) + (toolUse ?? 0)
  const candidates = count(usage.candidatesTokenCount)
  const thoughts = count(usage.thoughtsTokenCount)
  if (candidates !== undefined || thoughts !== undefined) out.outputTokens = (candidates ?? 0) + (thoughts ?? 0)
  if (thoughts !== undefined) out.reasoningTokens = thoughts
  const cached = count(usage.cachedContentTokenCount)
  if (cached !== undefined) out.cachedInputTokens = cached
  const total = count(usage.totalTokenCount)
  if (total !== undefined) out.totalTokens = total
  return Object.keys(out).length > 0 ? out : undefined
}

/** `STOP` after a function call means the model stopped to use a tool. */
export function mapGeminiFinishReason(reason: string | undefined, sawToolCall: boolean): StopReason {
  switch (reason) {
    case 'STOP':
      return sawToolCall ? 'tool_use' : 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'LANGUAGE':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'MISSING_THOUGHT_SIGNATURE':
    case 'UNEXPECTED_TOOL_CALL':
    case 'TOO_MANY_TOOL_CALLS':
    case 'MALFORMED_RESPONSE':
      return 'error'
    default:
      return 'unknown'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const signatureEvent = (signature: string): AIStreamEvent => ({
  type: 'metadata',
  data: { reasoningBlock: { signature: packGeminiSignature(signature) } }
})

/** Stateful translation of one response (a stream of chunks, or a single chunk). */
export class GeminiStreamMapper {
  private started = false
  private responseId: string | undefined
  private callIndex = 0
  private sawText = false
  private sawToolCall = false
  private usage: Usage | undefined
  private finishReason: string | undefined
  private finishMessage: string | undefined
  private ratings: GeminiSafetyRating[] | undefined

  constructor(
    private readonly provider: string,
    private readonly model: string
  ) {}

  /** Events for one chunk. Throws a `NormalizedAIError` for an in-band error or a blocked prompt. */
  push(chunk: GemChunk): AIStreamEvent[] {
    if (chunk.error) {
      throw normalizeGeminiError({ provider: this.provider, status: count(chunk.error.code) ?? 502, body: chunk })
    }
    const blockReason = chunk.promptFeedback?.blockReason
    if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED' && !chunk.candidates?.length) {
      throw geminiStopError(this.provider, { blockReason, ratings: chunk.promptFeedback?.safetyRatings })!
    }

    const events: AIStreamEvent[] = []
    if (!this.started) {
      this.started = true
      this.responseId = chunk.responseId
      events.push({
        type: 'start',
        provider: this.provider,
        model: this.model,
        ...(chunk.responseId ? { requestId: chunk.responseId } : {})
      })
    }

    // Counts are cumulative, so a later chunk replaces earlier values rather than adding to them.
    const usage = mapGeminiUsage(chunk.usageMetadata)
    if (usage) this.usage = { ...this.usage, ...usage }

    const candidate = chunk.candidates?.find((c) => (c.index ?? 0) === 0)
    if (!candidate) return events
    for (const part of candidate.content?.parts ?? []) this.mapPart(part, events)
    if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      this.finishReason = candidate.finishReason
      this.finishMessage = candidate.finishMessage
    }
    if (candidate.safetyRatings?.length) this.ratings = candidate.safetyRatings
    return events
  }

  private mapPart(part: GemResponsePart, events: AIStreamEvent[]): void {
    const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : undefined
    if (part.functionCall) {
      const { name, id } = part.functionCall
      if (typeof name !== 'string' || !name) return
      const args = isObject(part.functionCall.args) ? part.functionCall.args : {}
      const callId = geminiCallId({ ...(typeof id === 'string' ? { id } : {}), name, args }, this.callIndex++, this.responseId)
      this.sawToolCall = true
      events.push({ type: 'tool_call', toolCall: { id: callId, name, input: args as never } })
    } else if (typeof part.text === 'string') {
      if (part.thought === true) {
        if (part.text) events.push({ type: 'reasoning_delta', text: part.text })
      } else if (part.text) {
        this.sawText = true
        events.push({ type: 'text_delta', text: part.text })
      }
    }
    // Images, code execution and other part kinds are not rendered here, but the
    // model may have signed them, and a signature is only valid replayed.
    if (signature) events.push(signatureEvent(signature))
  }

  /** The closing events (stop reason, usage), or a throw when the response was not a usable one. */
  end(): AIStreamEvent[] {
    if (!this.started) throw this.failure('EMPTY_RESPONSE', 'Gemini returned no response.')
    const finish = this.finishReason
    if (finish === undefined) throw this.failure('TRUNCATED', 'The response ended before Gemini finished it.')

    const answered = this.sawText || this.sawToolCall
    const stopError = geminiStopError(this.provider, {
      finishReason: finish,
      ...(this.finishMessage ? { finishMessage: this.finishMessage } : {}),
      ...(this.ratings ? { ratings: this.ratings } : {})
    })
    if (stopError) {
      // A safety stop after some output is a graceful end; every other failure is an error.
      if (stopError.category !== 'CONTENT_POLICY' || !answered) throw stopError
    } else if (!answered && finish !== 'MAX_TOKENS') {
      // Finished, yet nothing to show (thoughts only, or nothing). A retry usually answers.
      throw this.failure('EMPTY_RESPONSE', 'Gemini returned an empty response.')
    }

    const events: AIStreamEvent[] = [{ type: 'stop', stopReason: mapGeminiFinishReason(finish, this.sawToolCall) }]
    if (this.usage) events.push({ type: 'usage', usage: this.usage })
    return events
  }

  private failure(rawCode: string, message: string): NormalizedAIError {
    return new NormalizedAIError({
      provider: this.provider,
      category: 'STREAM_ERROR',
      message,
      classification: 'transient',
      retryable: true,
      rawCode
    })
  }
}
