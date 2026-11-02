import type { MessageContentPart } from './content'
import type { ToolCall } from './tools'

export type StopReason =
  | 'stop' // natural completion
  | 'length' // hit max output tokens
  | 'tool_use' // stopped to call a tool
  | 'content_filter' // provider content policy
  | 'cancelled' // user aborted
  | 'error'
  | 'unknown'

/**
 * Token counts for one request, in one convention whatever the provider reports: `inputTokens` is the whole prompt
 * (system, tools and history), the cached counts are subsets of it, and `outputTokens` is everything generated,
 * thinking included. Anthropic reports the three input kinds apart and the adapter sums them; OpenAI's and Gemini's
 * prompt counts already include the cached part. A consumer therefore never adds a cached count to
 * `inputTokens`. The context meter reads `inputTokens` alone: it is what the request put in the window, while
 * `outputTokens` is not, since thinking is rarely sent back.
 */
export interface Usage {
  /** Total input context, including cache reads and cache writes when reported. */
  inputTokens?: number
  /** Everything generated, `reasoningTokens` included. */
  outputTokens?: number
  totalTokens?: number
  /** The part of `outputTokens` spent thinking. It counts toward the next request's input only if the history carries it. */
  reasoningTokens?: number
  /** Subset of inputTokens read from the provider's prompt cache. */
  cachedInputTokens?: number
  /** Subset of inputTokens used to create provider prompt-cache entries. */
  cacheWriteInputTokens?: number
  /** Subset of cacheWriteInputTokens written with the 1-hour lifetime (billed at a higher rate on Anthropic). */
  cacheWrite1hInputTokens?: number
  /** Cost in USD as reported by the provider itself (OpenRouter's usage.cost); preferred over any estimate. */
  reportedCostUsd?: number
}

export interface Timings {
  startedAt: number
  firstTokenAt?: number
  completedAt?: number
  /** Time to first token, ms. */
  ttftMs?: number
  totalMs?: number
}

/**
 * Unified response. `text` is a convenience concatenation of text parts; the
 * full `content` array preserves tool_use / reasoning parts in order.
 */
export interface AIResponse {
  id: string
  provider: string
  model: string
  content: MessageContentPart[]
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage?: Usage
  requestId?: string
  createdAt: number
  timings?: Timings
  /** Raw provider payload for developer mode (must be redacted before display). */
  raw?: unknown
}
