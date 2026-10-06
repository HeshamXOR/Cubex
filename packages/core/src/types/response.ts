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

export interface Usage {
  /** Total input context, including cache reads and cache writes when reported. */
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
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
