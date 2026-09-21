import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import type { Usage } from '../../types/response'
import type { MessageContentPart } from '../../types/content'
import { normalizeHttpError, normalizeUnknownError } from '../../errors/normalize'
import { parseSSEJson } from '../../streaming/sse'
import { withTimeout } from '../../util/timeout'
import { BaseProvider, buildAuthHeaders, normalizeBaseUrl } from '../base'
import {
  mapChatUsage,
  mapFinishReason,
  toChatCompletionsBody,
  type ChatToolCall
} from '../openai/translate'

const DEFAULT_CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

/** A streaming chat completion chunk (subset we consume). */
interface ChatChunk {
  id?: string
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<ChatToolCall & { index: number }> }
    finish_reason?: string | null
  }>
  usage?: Parameters<typeof mapChatUsage>[0]
}

/**
 * Speaks the OpenAI Chat Completions wire format against an arbitrary base URL
 * using raw `fetch` + SSE parsing (no SDK). Powers self-hosted / third-party
 * OpenAI-compatible servers (vLLM, LocalAI, Together, Groq, llama.cpp, LM Studio…).
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly kind: ProviderKind
  readonly id: string
  readonly name: string

  protected readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(
    protected readonly cfg: ProviderConfig,
    protected readonly secret?: string,
    kind: ProviderKind = 'openai-compat'
  ) {
    super()
    this.kind = kind
    this.id = cfg.id
    this.name = cfg.name
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl, 'https://api.openai.com/v1')
    // Respect declared capability overrides so supports() reflects the server.
    this.setCapabilities(cfg.capabilities ?? DEFAULT_CAPS)
    this.fetchImpl = globalThis.fetch
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...buildAuthHeaders(this.cfg, this.secret),
      ...(extra ?? {})
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers() })
      if (!res.ok) throw await this.httpError(res)
      const json = (await res.json()) as { data?: Array<{ id: string }> }
      const data = json.data ?? []
      if (data.length > 0) {
        return data.map((m) => this.toModelInfo(m.id)).sort((a, b) => a.id.localeCompare(b.id))
      }
    } catch {
      // fall through to fallback
    }
    const fallback = this.cfg.defaultModel
    return fallback ? [this.toModelInfo(fallback)] : []
  }

  private toModelInfo(id: string): ModelInfo {
    const caps = this.cfg.capabilities ?? DEFAULT_CAPS
    return {
      id,
      providerId: this.id,
      displayName: id,
      location: 'cloud',
      capabilities: caps,
      modalities: { input: caps.includes('image_input') ? ['text', 'image'] : ['text'], output: ['text'] },
      supportsTools: caps.includes('tools'),
      supportsStructuredOutput: caps.includes('structured_output'),
      supportsReasoning: caps.includes('reasoning')
    }
  }

  /** Reject unsupported content BEFORE sending, per declared capabilities. */
  private assertContentSupported(request: AIRequest): void {
    const hasImage = request.messages.some((m) => m.content.some((p: MessageContentPart) => p.type === 'image'))
    if (hasImage && !this.supports('image_input') && !this.supports('vision')) {
      throw new NormalizedAIError({
        provider: this.id,
        category: 'INVALID_REQUEST',
        message: 'This model does not support image input.',
        classification: 'permanent',
        retryable: false
      })
    }
    if (request.tools && request.tools.length > 0 && !this.supports('tools')) {
      throw new NormalizedAIError({
        provider: this.id,
        category: 'INVALID_REQUEST',
        message: 'This model does not support tool calling.',
        classification: 'permanent',
        retryable: false
      })
    }
    if (request.responseFormat?.type === 'json_schema' && !this.supports('structured_output')) {
      throw new NormalizedAIError({
        provider: this.id,
        category: 'INVALID_REQUEST',
        message: 'This model does not support structured output (json_schema).',
        classification: 'permanent',
        retryable: false
      })
    }
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    this.assertContentSupported(request)

    const { signal, clear } = withTimeout(options?.timeout, options?.signal)
    const body = toChatCompletionsBody(request, { stream: true, maxTokensField: 'max_tokens' })

    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(options?.headers),
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      clear()
      throw normalizeUnknownError(this.id, err)
    }

    if (!res.ok) {
      const err = await this.httpError(res)
      clear()
      throw err
    }

    try {
      yield { type: 'start', provider: this.id, model: request.model }
      let usage: Usage | undefined
      for await (const { data } of parseSSEJson<ChatChunk>(res.body, { signal })) {
        const choice = data.choices?.[0]
        if (choice) {
          if (choice.delta?.content) yield { type: 'text_delta', text: choice.delta.content }
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const evt: Extract<AIStreamEvent, { type: 'tool_call_delta' }> = { type: 'tool_call_delta', index: tc.index }
              if (tc.id) evt.id = tc.id
              if (tc.function?.name) evt.name = tc.function.name
              if (tc.function?.arguments) evt.argsDelta = tc.function.arguments
              yield evt
            }
          }
          if (choice.finish_reason) yield { type: 'stop', stopReason: mapFinishReason(choice.finish_reason) }
        }
        const u = mapChatUsage(data.usage)
        if (u) usage = u
      }
      if (usage) yield { type: 'usage', usage }
    } catch (err) {
      throw normalizeUnknownError(this.id, err)
    } finally {
      clear()
    }
  }

  async validateConfiguration(): Promise<ValidationResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) {
        const err = await this.httpError(res)
        return {
          ok: false,
          message:
            err.category === 'AUTHENTICATION_ERROR'
              ? 'Authentication failed: check the API key.'
              : `Validation failed: ${err.message}`
        }
      }
      const json = (await res.json().catch(() => ({}))) as { data?: unknown[] }
      return { ok: true, details: { endpoint: this.baseUrl, models: json.data?.length ?? 0 } }
    } catch (err) {
      const norm = normalizeUnknownError(this.id, err)
      return { ok: false, message: `Not reachable at ${this.baseUrl}: ${norm.message}` }
    }
  }

  /** Build a NormalizedAIError from a non-OK Response, reading retry-after + body. */
  protected async httpError(res: Response): Promise<NormalizedAIError> {
    let body: unknown
    const text = await res.text().catch(() => '')
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return normalizeHttpError({
      provider: this.id,
      status: res.status,
      headers: res.headers,
      body
    })
  }
}
