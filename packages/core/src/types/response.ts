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
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
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
