import type { JSONSchema } from './common'
import type { MessageContentPart } from './content'
import type { AIMessage } from './message'
import type { ToolChoice, ToolDefinition } from './tools'

export interface SamplingParams {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  seed?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /**
   * Reasoning/thinking effort hint. The full union spans every provider's
   * vocabulary; each adapter maps it to that provider's supported subset:
   *  - Anthropic: minimal→low, then low/medium/high/xhigh/max (output_config.effort)
   *  - OpenAI:    minimal(GPT-5 only)/low/medium/high (reasoning_effort)
   *  - others:    ignored
   */
  reasoningEffort?: ReasoningEffort
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Structured-output / response-format request. */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: JSONSchema; strict?: boolean }

/**
 * The unified request. Adapters translate this into each provider's native shape;
 * nothing here is provider-specific.
 */
export interface AIRequest {
  model: string
  messages: AIMessage[]
  /** System / developer prompt. */
  system?: string | MessageContentPart[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  responseFormat?: ResponseFormat
  params?: SamplingParams
  /** Provider metadata passthrough (e.g. user id for abuse monitoring). */
  metadata?: Record<string, string>
  stream?: boolean
}

/**
 * When a request is stopped. A request is only cut when it is stuck, never for being slow or long: once data is
 * arriving, only `streamIdleMs` (silence) and an explicit `totalMs` can end it. A limit of 0 turns that limit off,
 * and a missing value means its default (`DEFAULT_TIMEOUT_CONFIG`). Read it through `resolveTimeouts`.
 */
export interface TimeoutConfig {
  connectionMs?: number
  /** How long to wait for the response to begin, for example while the provider queues the request. Default 10 minutes. */
  requestMs?: number
  /** How long a response that has begun may send nothing. Every piece of data restarts the clock. Default 5 minutes. */
  streamIdleMs?: number
  /** A hard ceiling on one request, even while data is still arriving. 0 or absent means no ceiling. */
  totalMs?: number
  /** Local runtime cold-start allowance. */
  localStartupMs?: number
}

/** `'output'` is model output (text, reasoning, a tool call); `'data'` is any other sign of life from the server. */
export type ActivityKind = 'data' | 'output'

/** Per-call options passed alongside a request. */
export interface RequestOptions {
  signal?: AbortSignal
  /** The gateway enforces these limits itself. An adapter reads them only to size an SDK client's own timeout. */
  timeout?: TimeoutConfig
  /** Extra headers merged into the outbound request (never logged raw). */
  headers?: Record<string, string>
  /**
   * Called when the provider is heard from, including keep-alive comments that never become stream events, so the
   * gateway can restart its silence clock. Optional: an adapter that cannot tell simply never calls it.
   */
  onActivity?: (kind: ActivityKind) => void
}
