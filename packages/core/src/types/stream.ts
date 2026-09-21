import type { NormalizedAIError } from './errors'
import type { AIResponse, StopReason, Usage } from './response'
import type { ToolCall } from './tools'

/**
 * Normalized streaming event model. Provider adapters translate their native
 * SSE/event formats into this union; the UI only ever renders these.
 */
export type AIStreamEvent =
  | { type: 'start'; provider: string; model: string; requestId?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'tool_call_delta'
      index: number
      id?: string
      name?: string
      /** Partial JSON string for the tool arguments. */
      argsDelta?: string
    }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'metadata'; data: Record<string, unknown> }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'completed'; response: AIResponse }
  | { type: 'error'; error: NormalizedAIError }

export type AIStreamEventType = AIStreamEvent['type']
