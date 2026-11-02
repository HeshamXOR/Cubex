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
import { createThinkTagParser } from '../../streaming/thinkTagParser'
import { chatFetchInit } from '../../util/chatFetch'
import { withTimeout } from '../../util/timeout'
import { BaseProvider, buildAuthHeaders, normalizeBaseUrl } from '../base'
import { infersReasoning, requestWithSupportedEffort, type EffortModel } from '../effort'
import { ChatDialects, chatExtrasRejected, chatExtrasSent, chatRefusedForResponses, type ChatDialect } from '../openai/dialect'
import { OpenAIProvider } from '../openai/OpenAIProvider'
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
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      thought?: string | null
      tool_calls?: Array<ChatToolCall & { index?: number }>
    }
    finish_reason?: string | null
    /** Kimi (Moonshot) reports stream usage inside the final choice rather than at the top level. */
    usage?: Parameters<typeof mapChatUsage>[0]
  }>
  usage?: Parameters<typeof mapChatUsage>[0]
  /** In-band upstream failure (OpenRouter, vLLM) sent after HTTP 200. */
  error?: { code?: number | string; message?: string; type?: string }
}

/**
 * Fold a later usage report of one stream into the earlier ones. Servers send usage in pieces (the prompt count
 * early, the rest with the last chunk) and some close the stream with a chunk of zeros. Counts only grow within a
 * request, so a field the new report leaves out, or reports as 0 over a positive count, keeps its earlier value.
 */
function mergeUsage(earlier: Usage | undefined, later: Usage): Usage {
  if (!earlier) return later
  const merged: Usage = { ...earlier }
  for (const key of Object.keys(later) as Array<keyof Usage>) {
    const value = later[key]
    if (value === undefined || (value === 0 && (earlier[key] ?? 0) > 0)) continue
    merged[key] = value
  }
  return merged
}

/**
 * Speaks the OpenAI Chat Completions wire format against an arbitrary base URL
 * using raw `fetch` + SSE parsing (no SDK). Powers self-hosted / third-party
 * OpenAI-compatible servers (vLLM, LocalAI, Together, Groq, llama.cpp, LM Studio…).
 *
 * A model that goes through the Responses API (`apiMode: 'responses'`, or a server that
 * turned a Chat Completions request away naming /v1/responses) is handed to an
 * OpenAIProvider on the same host, so there is one Responses implementation.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly kind: ProviderKind
  readonly id: string
  readonly name: string

  protected readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  /** Models whose server wants the Responses API: all of them when chosen, else those it has turned away so far. */
  private readonly responsesModels = new Set<string>()
  private readonly responsesFirst: boolean
  private responsesProvider: OpenAIProvider | undefined

  constructor(
    protected readonly cfg: ProviderConfig,
    protected readonly secret?: string,
    kind: ProviderKind = 'openai-compat',
    /** What the app knows about a model that its endpoint does not list. */
    private readonly modelInfo?: (modelId: string) => EffortModel | undefined
  ) {
    super()
    this.kind = kind
    this.id = cfg.id
    this.name = cfg.name
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl, 'https://api.openai.com/v1')
    this.dialects = new ChatDialects(this.baseUrl)
    // Respect declared capability overrides so supports() reflects the server.
    this.setCapabilities(cfg.capabilities ?? DEFAULT_CAPS)
    this.fetchImpl = globalThis.fetch
    this.responsesFirst = this.responsesCapable && cfg.apiMode === 'responses'
  }

  /** Azure routes by deployment and has its own wire; it never switches to the Responses API. */
  private get responsesCapable(): boolean {
    return this.cfg.apiMode !== 'azure'
  }

  /** The Responses adapter for this host, built on first use with the same URL, auth, headers and capabilities. */
  private responses(): OpenAIProvider {
    if (!this.responsesProvider) {
      const provider = new OpenAIProvider({ ...this.cfg, kind: 'openai', baseUrl: this.baseUrl, apiMode: 'responses' }, this.secret, {
        headers: buildAuthHeaders(this.cfg, this.secret),
        // streamMessage has already checked the effort against what this model takes.
        effortAsChosen: true
      })
      provider.setCapabilities([...this.declaredCapabilities])
      this.responsesProvider = provider
    }
    return this.responsesProvider
  }

  private async *streamResponses(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    // The same overall limit a direct caller gets on the Chat Completions path.
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)
    try {
      yield* this.responses().streamMessage(request, { ...options, signal })
    } finally {
      clear()
    }
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
      supportsReasoning: caps.includes('reasoning') || infersReasoning(id)
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

  /** What each model's server takes beyond the baseline, and what it has refused so far. */
  private readonly dialects: ChatDialects

  /**
   * Where a chat request goes and which field carries its token limit. Servers that
   * route differently (Azure OpenAI, by deployment) override this; nothing else
   * about the request or the stream changes.
   */
  protected chatTarget(_request: AIRequest): { url: string; maxTokensField: 'max_tokens' | 'max_completion_tokens' } {
    return { url: `${this.baseUrl}/chat/completions`, maxTokensField: 'max_tokens' }
  }

  /**
   * POST the chat request with the extras this host takes. A server that refuses
   * one (a 400 or 422 naming it) is asked again once without it, and the refusal
   * is remembered so later requests to that model skip the failed attempt.
   * Resolves with an OK response; any other outcome throws. A server that says the model
   * needs the Responses API resolves with nothing, and the model is remembered for it.
   */
  private async open(request: AIRequest, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<Response | undefined> {
    const target = this.chatTarget(request)
    const attempt = async (dialect: ChatDialect) => {
      const body = toChatCompletionsBody(request, { stream: true, maxTokensField: target.maxTokensField, effortAsChosen: true, ...dialect })
      const res = await this.fetchImpl(target.url, {
        method: 'POST',
        headers: this.headers(headers),
        body: JSON.stringify(body),
        signal,
        ...chatFetchInit()
      })
      return { res, body }
    }
    const first = await attempt(this.dialects.for(request.model))
    if (first.res.ok) return first.res
    const { error, text } = await this.readError(first.res)
    if (this.responsesCapable && chatRefusedForResponses(first.res.status, text)) {
      this.responsesModels.add(request.model)
      return undefined
    }
    const refused = chatExtrasRejected(first.res.status, text, chatExtrasSent(first.body))
    if (refused.length === 0) throw error
    this.dialects.refuse(request.model, refused)
    const second = await attempt(this.dialects.for(request.model))
    if (second.res.ok) return second.res
    throw await this.httpError(second.res)
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    this.assertContentSupported(request)
    const known = this.modelInfo?.(request.model)
    request = requestWithSupportedEffort(this.kind, request, {
      id: request.model,
      supportsReasoning: known?.supportsReasoning === true || this.supports('reasoning'),
      ...(known?.reasoningEfforts ? { reasoningEfforts: known.reasoningEfforts } : {})
    })

    if (this.responsesFirst || this.responsesModels.has(request.model)) {
      yield* this.streamResponses(request, options)
      return
    }

    const { signal, clear } = withTimeout(options?.timeout, options?.signal)

    let res: Response | undefined
    try {
      res = await this.open(request, options?.headers, signal)
    } catch (err) {
      clear()
      throw normalizeUnknownError(this.id, err)
    }
    if (!res) {
      // Nothing has been streamed yet, so the same request can go to the other endpoint.
      clear()
      yield* this.streamResponses(request, options)
      return
    }

    try {
      yield { type: 'start', provider: this.id, model: request.model }
      let usage: Usage | undefined
      // Some servers omit `index` on tool-call deltas; key them by id instead,
      // and attach id-less continuation deltas to the last call seen.
      const indexById = new Map<string, number>()
      let lastIndex = 0
      let sawNativeReasoning = false
      const thinkParser = createThinkTagParser()
      for await (const { data } of parseSSEJson<ChatChunk>(res.body, { signal, onActivity: options?.onActivity })) {
        if (data.error) {
          // A 200 stream can still fail upstream. Never report the partial text as a finished answer.
          throw normalizeHttpError({ provider: this.id, status: Number(data.error.code) || 502, body: { error: data.error } })
        }
        const choice = data.choices?.[0]
        if (choice) {
          // DeepSeek and other compatible endpoints stream reasoning separately
          // from the answer. Forward it as it arrives, including before tools.
          const textReasoning = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
          const reasoning = textReasoning(choice.delta?.reasoning_content) || textReasoning(choice.delta?.reasoning) || textReasoning(choice.delta?.thought)
          if (reasoning) {
            sawNativeReasoning = true
            yield { type: 'reasoning_delta', text: reasoning }
          }
          if (choice.delta?.content) {
            if (sawNativeReasoning) {
              yield { type: 'text_delta', text: choice.delta.content }
            } else {
              for (const event of thinkParser.push(choice.delta.content)) yield event
            }
          }
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              let index: number
              if (typeof tc.index === 'number') index = tc.index
              else if (tc.id) {
                if (!indexById.has(tc.id)) indexById.set(tc.id, indexById.size)
                index = indexById.get(tc.id)!
              } else index = lastIndex
              lastIndex = index
              const evt: Extract<AIStreamEvent, { type: 'tool_call_delta' }> = { type: 'tool_call_delta', index }
              if (tc.id) evt.id = tc.id
              if (tc.function?.name) evt.name = tc.function.name
              if (tc.function?.arguments) evt.argsDelta = tc.function.arguments
              yield evt
            }
          }
          if (choice.finish_reason === 'error') {
            throw normalizeHttpError({ provider: this.id, status: 502, body: { error: { message: 'The upstream model failed mid-response.' } } })
          }
          if (choice.finish_reason) {
            for (const event of thinkParser.flush()) yield event
            yield { type: 'stop', stopReason: mapFinishReason(choice.finish_reason) }
          }
        }
        const u = mapChatUsage(data.usage ?? choice?.usage)
        if (u) usage = mergeUsage(usage, u)
      }
      for (const event of thinkParser.flush()) yield event
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
    return (await this.readError(res)).error
  }

  /** The normalized error for a non-OK response, with the raw body text it was read from. */
  private async readError(res: Response): Promise<{ error: NormalizedAIError; text: string }> {
    let body: unknown
    const text = await res.text().catch(() => '')
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    const error = normalizeHttpError({
      provider: this.id,
      status: res.status,
      headers: res.headers,
      body
    })
    return { error, text }
  }
}
