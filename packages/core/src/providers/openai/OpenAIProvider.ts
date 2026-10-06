import OpenAI, { APIError } from 'openai'
import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import { sdkTimeoutMs } from '../../types/timeout'
import type { AIStreamEvent } from '../../types/stream'
import type { Usage } from '../../types/response'
import { normalizeHttpError, normalizeUnknownError } from '../../errors/normalize'
import { BaseProvider, normalizeBaseUrl } from '../base'
import { requestWithSupportedEffort } from '../effort'
import { ChatDialects, chatExtrasRejected, chatExtrasSent, type ChatDialect } from './dialect'
import {
  mapChatUsage,
  mapFinishReason,
  mapResponsesStopReason,
  mapResponsesUsage,
  toChatCompletionsBody,
  toResponsesBody,
  type ChatToolCall
} from './translate'

/** Model id prefixes that support image input (multimodal). */
const VISION_PREFIXES = ['gpt-6', 'gpt-5', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'o1', 'o3', 'o4', 'chatgpt-4o']

/** Model id prefixes that expose reasoning tokens / effort. */
const REASONING_PREFIXES = ['gpt-6', 'gpt-5', 'o1', 'o3', 'o4']

function isVisionModel(id: string): boolean {
  return VISION_PREFIXES.some((p) => id.startsWith(p))
}
function isReasoningModel(id: string): boolean {
  return REASONING_PREFIXES.some((p) => id.startsWith(p))
}

const BASE_CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'structured_output',
  'json_mode',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

function capsForModel(id: string): Capability[] {
  const caps = new Set<Capability>(BASE_CAPS)
  if (isVisionModel(id)) {
    caps.add('vision')
    caps.add('image_input')
  }
  if (isReasoningModel(id)) caps.add('reasoning')
  return [...caps]
}

/**
 * Static fallback when `models.list()` is unavailable. Current flagships first;
 * the live endpoint is always preferred, so this only shows if listing fails.
 */
const FALLBACK_MODEL_IDS = ['gpt-6-astra', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o', 'gpt-4o-mini']

/**
 * OpenAI adapter. Supports both the Responses API (default) and Chat Completions
 * (`cfg.apiMode === 'chat_completions'`) via the official `openai` SDK.
 */
export class OpenAIProvider extends BaseProvider {
  readonly kind: ProviderKind = 'openai'
  readonly id: string
  readonly name: string

  private readonly client: OpenAI
  private readonly apiMode: 'responses' | 'chat_completions'
  /** What each model's server takes beyond the baseline (Chat Completions only). */
  private readonly dialects: ChatDialects
  private modelsFallback = false

  constructor(
    private readonly cfg: ProviderConfig,
    secret?: string
  ) {
    super()
    this.id = cfg.id
    this.name = cfg.name
    this.apiMode = cfg.apiMode === 'chat_completions' ? 'chat_completions' : 'responses'
    // No base URL means OpenAI itself.
    this.dialects = new ChatDialects(cfg.baseUrl)
    this.client = new OpenAI({
      apiKey: secret ?? 'missing',
      // Trim a trailing slash to avoid "https://host//v1/..." on strict proxies.
      // Explicit so OPENAI_BASE_URL / OPENAI_ORG_ID / OPENAI_PROJECT_ID in the
      // environment never redirect traffic or the stored key.
      baseURL: cfg.baseUrl ? normalizeBaseUrl(cfg.baseUrl, cfg.baseUrl) : 'https://api.openai.com/v1',
      organization: null,
      project: null,
      dangerouslyAllowBrowser: false,
      // The gateway's RetryEngine is the single retry layer.
      maxRetries: 0
    })
    this.setCapabilities(
      cfg.capabilities ?? [...new Set<Capability>([...BASE_CAPS, 'vision', 'image_input', 'reasoning'])]
    )
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const page = await this.client.models.list()
      const models: ModelInfo[] = []
      for (const m of page.data) {
        models.push(this.toModelInfo(m.id))
      }
      if (models.length > 0) {
        this.modelsFallback = false
        return models.sort((a, b) => a.id.localeCompare(b.id))
      }
    } catch {
      // fall through to static fallback
    }
    this.modelsFallback = true
    return FALLBACK_MODEL_IDS.map((id) => this.toModelInfo(id))
  }

  private toModelInfo(id: string): ModelInfo {
    const caps = capsForModel(id)
    const vision = caps.includes('vision')
    return {
      id,
      providerId: this.id,
      displayName: id,
      location: 'cloud',
      capabilities: caps,
      modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] },
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsReasoning: caps.includes('reasoning'),
      ...(this.modelsFallback ? { notes: 'Static fallback list (models.list unavailable)' } : {})
    }
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const signal = options?.signal
    if (signal?.aborted) throw this.abort()
    request = requestWithSupportedEffort(this.kind, request, {
      id: request.model,
      supportsReasoning: this.supports('reasoning') && this.toModelInfo(request.model).supportsReasoning
    })
    try {
      if (this.apiMode === 'chat_completions') {
        yield* this.streamChat(request, options)
      } else {
        yield* this.streamResponses(request, options)
      }
    } catch (err) {
      throw this.wrap(err)
    }
  }

  /**
   * Open the Chat Completions stream with the extras this host takes. A 400 or
   * 422 naming one of them is retried once without it, and remembered for the
   * model; every other error, and a second failure, propagates unchanged.
   */
  private async openChat(request: AIRequest, options?: RequestOptions) {
    const requestOptions = { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.headers ? { headers: options.headers } : {}), timeout: sdkTimeoutMs(options?.timeout) }
    const attempt = (dialect: ChatDialect) => {
      const body = toChatCompletionsBody(request, { stream: true, maxTokensField: 'max_completion_tokens', ...dialect })
      const stream = this.client.chat.completions.create(body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming, requestOptions)
      return { body, stream }
    }
    const first = attempt(this.dialects.for(request.model))
    try {
      return await first.stream
    } catch (err) {
      const refused = err instanceof APIError ? chatExtrasRejected(err.status, err.message, chatExtrasSent(first.body)) : []
      if (refused.length === 0) throw err
      this.dialects.refuse(request.model, refused)
    }
    return attempt(this.dialects.for(request.model)).stream
  }

  private async *streamChat(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const stream = await this.openChat(request, options)

    let started = false
    let usage: Usage | undefined
    for await (const chunk of stream) {
      if (!started) {
        started = true
        yield { type: 'start', provider: this.id, model: request.model, ...(chunk.id ? { requestId: chunk.id } : {}) }
      }
      const choice = chunk.choices[0]
      if (choice) {
        const delta = choice.delta
        // Custom OpenAI base URLs can expose the compatible reasoning fields.
        // They are not part of the SDK's Chat Completions response type.
        const extended = delta as typeof delta & { reasoning_content?: unknown; reasoning?: unknown }
        const primaryReasoning = extended?.reasoning_content
        const reasoning = typeof primaryReasoning === 'string' && primaryReasoning ? primaryReasoning : extended?.reasoning
        if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning_delta', text: reasoning }
        if (delta?.content) yield { type: 'text_delta', text: delta.content }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls as ChatToolCall[] & { index: number }[]) {
            const evt: Extract<AIStreamEvent, { type: 'tool_call_delta' }> = { type: 'tool_call_delta', index: tc.index }
            if (tc.id) evt.id = tc.id
            if (tc.function?.name) evt.name = tc.function.name
            if (tc.function?.arguments) evt.argsDelta = tc.function.arguments
            yield evt
          }
        }
        if (choice.finish_reason) yield { type: 'stop', stopReason: mapFinishReason(choice.finish_reason) }
      }
      // Kimi reports stream usage inside the final choice rather than at the top level.
      const u = mapChatUsage(chunk.usage ?? (choice as { usage?: typeof chunk.usage } | undefined)?.usage)
      if (u) usage = u
    }
    if (usage) yield { type: 'usage', usage }
  }

  private async *streamResponses(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const body = toResponsesBody(request, true)
    const stream = await this.client.responses.create(
      body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.headers ? { headers: options.headers } : {}), timeout: sdkTimeoutMs(options?.timeout) }
    )

    let started = false
    // Track function-call items by output_index to correlate deltas.
    const callIndex = new Map<number, number>()
    let nextToolIndex = 0

    for await (const event of stream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>) {
      const type = event.type
      if (type === 'response.created' || type === 'response.in_progress') {
        if (!started) {
          started = true
          const id = 'response' in event ? event.response?.id : undefined
          yield { type: 'start', provider: this.id, model: request.model, ...(id ? { requestId: id } : {}) }
        }
      } else if (type === 'response.output_text.delta') {
        if (event.delta) yield { type: 'text_delta', text: event.delta }
      } else if (type === 'response.reasoning_summary_text.delta') {
        // Only provider-published summary text is shown. Encrypted reasoning
        // items and summary .done copies are deliberately not exposed/repeated.
        if (typeof event.delta === 'string' && event.delta) yield { type: 'reasoning_delta', text: event.delta }
      } else if (type === 'response.output_item.added') {
        const item = event.item
        if (item.type === 'function_call') {
          const idx = nextToolIndex++
          callIndex.set(event.output_index, idx)
          yield {
            type: 'tool_call_delta',
            index: idx,
            ...(item.call_id ? { id: item.call_id } : {}),
            ...(item.name ? { name: item.name } : {})
          }
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const idx = callIndex.get(event.output_index) ?? 0
        yield { type: 'tool_call_delta', index: idx, argsDelta: event.delta }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const resp = event.response
        const usage = mapResponsesUsage(resp?.usage as Parameters<typeof mapResponsesUsage>[0])
        if (usage) yield { type: 'usage', usage }
        const incompleteReason = resp?.incomplete_details?.reason ?? null
        // The Responses API signals tool use via function_call output items, not
        // via `status` — so map to 'tool_use' when we emitted any tool call and
        // the turn wasn't truncated. Otherwise downstream (ToolRunner, stopReason
        // display) never sees tool_use for the Responses adapter.
        const base = mapResponsesStopReason(resp?.status, incompleteReason)
        const stopReason = base === 'stop' && nextToolIndex > 0 ? 'tool_use' : base
        yield { type: 'stop', stopReason }
      } else if (type === 'response.failed') {
        const err = event.response?.error
        throw normalizeHttpError({
          provider: this.id,
          status: 500,
          body: err ?? undefined,
          message: err?.message ?? 'Response failed'
        })
      }
    }
  }

  async validateConfiguration(): Promise<ValidationResult> {
    try {
      const page = await this.client.models.list({ signal: AbortSignal.timeout(8000) })
      return { ok: true, details: { models: page.data.length, apiMode: this.apiMode } }
    } catch (err) {
      const norm = this.wrap(err)
      return {
        ok: false,
        message:
          norm.category === 'AUTHENTICATION_ERROR'
            ? 'Authentication failed: check the API key.'
            : `Validation failed: ${norm.message}`
      }
    }
  }

  private abort(): NormalizedAIError {
    return new NormalizedAIError({
      provider: this.id,
      category: 'CANCELLED',
      message: 'Generation stopped',
      classification: 'permanent',
      retryable: false
    })
  }

  /** Normalize an SDK/thrown error into a NormalizedAIError. */
  private wrap(err: unknown): NormalizedAIError {
    if (err instanceof NormalizedAIError) return err
    if (err instanceof APIError) {
      // Abort surfaces as APIUserAbortError (status undefined).
      const status = (err as APIError).status
      if (status === undefined) {
        const name = (err as { name?: string }).name
        if (name === 'APIUserAbortError') return this.abort()
        return normalizeUnknownError(this.id, err)
      }
      return normalizeHttpError({
        provider: this.id,
        status,
        ...(err.headers ? { headers: err.headers as unknown as Record<string, string> } : {}),
        body: err.error,
        ...(err.request_id ? { requestId: err.request_id } : {}),
        ...(typeof err.code === 'string' ? { rawCode: err.code } : {}),
        message: err.message,
        cause: err
      })
    }
    return normalizeUnknownError(this.id, err)
  }
}
