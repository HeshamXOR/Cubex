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

export interface TimeoutConfig {
  connectionMs?: number
  requestMs?: number
  /** Abort if no stream chunk arrives within this window. */
  streamIdleMs?: number
  totalMs?: number
  /** Local runtime cold-start allowance. */
  localStartupMs?: number
}

/** Per-call options passed alongside a request. */
export interface RequestOptions {
  signal?: AbortSignal
  timeout?: TimeoutConfig
  /** Extra headers merged into the outbound request (never logged raw). */
  headers?: Record<string, string>
}
