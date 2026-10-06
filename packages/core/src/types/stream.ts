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

/**
 * Whether an event carries something the model produced (text, reasoning, a tool call), as opposed to bookkeeping
 * such as the start, usage and stop events. Once any has been shown a request cannot be replayed, and a response
 * that is producing output is no longer "waiting to begin".
 */
export function isOutputEvent(event: AIStreamEvent): boolean {
  return event.type === 'text_delta' || event.type === 'reasoning_delta' || event.type === 'tool_call' || event.type === 'tool_call_delta'
}
