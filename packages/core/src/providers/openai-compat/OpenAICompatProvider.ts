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
import { isOutputEvent } from '../../types/stream'
import { AnthropicProvider } from '../anthropic/AnthropicProvider'
import { BaseProvider, buildAuthHeaders, normalizeBaseUrl, streamEndedEarly } from '../base'
import { infersReasoning, requestWithSupportedEffort, type EffortModel } from '../effort'
import {
  endpointFailed,
  endpointsFromList,
  endpointsNamedInRefusal,
  preferredEndpoints,
  withoutVersionPath,
  type ModelEndpoint
} from '../endpoints'
import { ChatDialects, chatExtrasRejected, chatExtrasSent, type ChatDialect } from '../openai/dialect'
import { OpenAIProvider } from '../openai/OpenAIProvider'
import { fetchGatewayPricing, type GatewayModel } from './gatewayPricing'
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

/** One entry of a server's model list. `supported_endpoint_types` is New-API's way of saying which formats serve the model. */
interface ListedModel {
  id: string
  supported_endpoint_types?: unknown
}

/** The endpoints a model list reports, by model. Empty when the list does not report them. */
function endpointMap(list: readonly ListedModel[]): Map<string, ModelEndpoint[]> {
  const out = new Map<string, ModelEndpoint[]>()
  for (const model of list) {
    const endpoints = endpointsFromList(model.supported_endpoint_types)
    if (endpoints) out.set(model.id, endpoints)
  }
  return out
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

/** A gateway moves models between its upstreams, so what it said about one is only trusted for a while. */
const REFUSAL_MEMORY_MS = 10 * 60 * 1000
const DISCOVERY_WAIT_MS = 3_000

/** Explicit API modes. Anything else leaves the choice to Cubex, model by model. */
const CHOSEN_ENDPOINT: Readonly<Record<string, ModelEndpoint>> = {
  chat_completions: 'chat',
  responses: 'responses',
  anthropic: 'anthropic'
}

interface RefusalMemory {
  /** Where the server said this model does work. */
  named?: ModelEndpoint[]
  /** Endpoints that turned it away without naming another. */
  refused: Set<ModelEndpoint>
  at: number
}

/**
 * Speaks the OpenAI Chat Completions wire format against an arbitrary base URL
 * using raw `fetch` + SSE parsing (no SDK). Powers self-hosted / third-party
 * OpenAI-compatible servers (vLLM, LocalAI, Together, Groq, llama.cpp, LM Studio…).
 *
 * A gateway can offer one model on several formats, so each model is routed on its own: Claude to the Messages API, GPT to
 * Responses, the rest to Chat Completions, as far as the server reports them. A busy endpoint fails over to the next one
 * before any of the reply has been shown, and a refusal naming another endpoint is followed. The other two formats are
 * handed to an AnthropicProvider and an OpenAIProvider on the same host, so each has one implementation.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly kind: ProviderKind
  readonly id: string
  readonly name: string

  protected readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly refusals = new Map<string, RefusalMemory>()
  /** What this host's model list says about endpoints, when it was asked outside getModels. */
  private discovered: Map<string, ModelEndpoint[]> | undefined
  private discovering: Promise<void> | undefined
  private responsesProvider: OpenAIProvider | undefined
  private anthropicProvider: AnthropicProvider | undefined

  constructor(
    protected readonly cfg: ProviderConfig,
    protected readonly secret?: string,
    kind: ProviderKind = 'openai-compat',
    /** What the app knows about a model that its endpoint does not list. */
    private readonly modelInfo?: (modelId: string) => EffortModel | undefined,
    /** Read the host's model list before the first request, when nothing else has yet. Off for a provider built just to be asked one thing. */
    private readonly discoverEndpoints = false
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
  }

  /** Azure routes by deployment and has its own wire; it stays on it. */
  private get routable(): boolean {
    return this.cfg.apiMode !== 'azure'
  }

  /** The person chose a format on the provider. */
  private get chosenEndpoint(): ModelEndpoint | undefined {
    return this.cfg.apiMode ? CHOSEN_ENDPOINT[this.cfg.apiMode] : undefined
  }

  private refusalsOf(model: string): RefusalMemory | undefined {
    const memory = this.refusals.get(model)
    if (memory && Date.now() - memory.at > REFUSAL_MEMORY_MS) {
      this.refusals.delete(model)
      return undefined
    }
    return memory
  }

  private remember(model: string, change: { named?: ModelEndpoint[]; refused?: ModelEndpoint }): void {
    const memory = this.refusalsOf(model) ?? { refused: new Set<ModelEndpoint>(), at: Date.now() }
    if (change.named) memory.named = change.named
    if (change.refused) memory.refused.add(change.refused)
    memory.at = Date.now()
    this.refusals.set(model, memory)
  }

  /** What the server has reported about this model, by any route. Undefined when it has not said. */
  private reportedEndpoints(model: string): ModelEndpoint[] | undefined {
    return this.refusalsOf(model)?.named ?? this.modelInfo?.(model)?.endpoints ?? this.discovered?.get(model)
  }

  /** The endpoints to try for this model, best first. */
  private routesFor(model: string): ModelEndpoint[] {
    if (!this.routable) return ['chat']
    const memory = this.refusalsOf(model)
    const reported = this.reportedEndpoints(model)
    const chosen = this.chosenEndpoint
    // Only a compatible server of unknown make is tried on a format its list has not reported. A local runtime has one.
    const automatic = chosen ? [] : this.kind === 'openai-compat' || reported ? preferredEndpoints(model, reported) : ['chat' as const]
    const order = [...new Set<ModelEndpoint>([...(chosen && !memory?.named ? [chosen] : []), ...(memory?.named ?? []), ...automatic])]
    const open = order.filter((endpoint) => !memory?.refused.has(endpoint))
    return open.length > 0 ? open : ['chat']
  }

  /** Read which endpoints each model has, once, for a provider whose list nothing has asked for yet. It never holds a request up for long. */
  private async discover(): Promise<void> {
    if (!this.discoverEndpoints || this.discovered || this.chosenEndpoint || !this.routable || this.kind !== 'openai-compat') return
    this.discovering ??= this.listModels(AbortSignal.timeout(DISCOVERY_WAIT_MS))
      .then((list) => { this.discovered = endpointMap(list) })
      .catch(() => { this.discovered = new Map() })
    await this.discovering
  }

  private async listModels(signal: AbortSignal): Promise<ListedModel[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers(), signal })
    if (!res.ok) throw await this.httpError(res)
    return ((await res.json()) as { data?: ListedModel[] }).data ?? []
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

  /** The Messages adapter for this host. Its SDK adds /v1 itself. A key goes in both headers, since gateways differ on which they read. */
  private anthropic(): AnthropicProvider {
    if (!this.anthropicProvider) {
      const provider = new AnthropicProvider(
        { ...this.cfg, kind: 'anthropic', baseUrl: withoutVersionPath(this.baseUrl), promptCaching: this.cfg.promptCaching ?? true },
        this.secret,
        { headers: buildAuthHeaders(this.cfg, this.secret) }
      )
      if (this.cfg.capabilities) provider.setCapabilities([...this.declaredCapabilities])
      this.anthropicProvider = provider
    }
    return this.anthropicProvider
  }

  private async *streamDelegate(provider: OpenAIProvider | AnthropicProvider, request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    // The same overall limit a direct caller gets on the Chat Completions path.
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)
    try {
      yield* provider.streamMessage(request, { ...options, signal })
    } finally {
      clear()
    }
  }

  private streamEndpoint(endpoint: ModelEndpoint, request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    if (endpoint === 'anthropic') return this.streamDelegate(this.anthropic(), request, options)
    if (endpoint === 'responses') return this.streamDelegate(this.responses(), request, options)
    return this.streamChat(request, options)
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
      const data = await this.listModels(AbortSignal.timeout(15_000))
      if (data.length > 0) {
        const endpoints = endpointMap(data)
        this.discovered = endpoints
        // A gateway that says which endpoints a model has also says what it charges for it.
        const gateway = endpoints.size > 0 ? await fetchGatewayPricing(this.baseUrl, this.fetchImpl) : new Map<string, GatewayModel>()
        return data
          // An image model is on the same list, and has no place in a chat.
          .filter((m) => endpoints.get(m.id)?.length !== 0)
          .map((m) => this.toModelInfo(m.id, endpoints.get(m.id), gateway.get(m.id)))
          .sort((a, b) => a.id.localeCompare(b.id))
      }
    } catch {
      // fall through to fallback
    }
    const fallback = this.cfg.defaultModel
    return fallback ? [this.toModelInfo(fallback)] : []
  }

  private toModelInfo(id: string, endpoints?: ModelEndpoint[], gateway?: GatewayModel): ModelInfo {
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
      supportsReasoning: caps.includes('reasoning') || gateway?.reasoning === true || infersReasoning(id),
      ...(endpoints?.length ? { endpoints } : {}),
      ...(gateway?.pricing ? { pricing: gateway.pricing } : {})
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
   * Resolves with an OK response; any other outcome throws.
   */
  private async open(request: AIRequest, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<Response> {
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

    await this.discover()

    // Until the reply starts, the same request can go to another endpoint. Once any of it has been shown it cannot.
    const tried = new Set<ModelEndpoint>()
    for (;;) {
      const endpoint = this.routesFor(request.model).find((candidate) => !tried.has(candidate))
      if (!endpoint) throw new NormalizedAIError({ provider: this.id, category: 'SERVER_ERROR', message: 'No endpoint of this server could take the request.', classification: 'transient', retryable: true })
      tried.add(endpoint)
      let produced = false
      try {
        for await (const event of this.streamEndpoint(endpoint, request, options)) {
          if (isOutputEvent(event)) produced = true
          yield event
        }
        return
      } catch (err) {
        const error = normalizeUnknownError(this.id, err)
        if (produced || options?.signal?.aborted) throw error
        const hasNext = this.followRefusal(request.model, endpoint, error, tried)
        if (!hasNext) throw error
      }
    }
  }

  /**
   * What a failed endpoint means for this model, and whether another is worth trying now. A refusal naming other endpoints
   * is believed and remembered. An endpoint that does not exist here, or a format that was only a guess, is remembered as
   * closed. A busy one is just skipped this time.
   */
  private followRefusal(model: string, endpoint: ModelEndpoint, error: NormalizedAIError, tried: ReadonlySet<ModelEndpoint>): boolean {
    if (!this.routable) return false
    const named = endpointsNamedInRefusal(error.statusCode, error.message)
    const status = error.statusCode ?? 0
    if (named.length > 0 && !named.includes(endpoint)) this.remember(model, { named, refused: endpoint })
    else if (endpoint !== 'chat' && (status === 404 || status === 405)) this.remember(model, { refused: endpoint })
    // A format tried without the server having reported it: any client error ends the guess, except being told to slow down.
    else if (endpoint === 'anthropic' && !this.reportedEndpoints(model) && !this.chosenEndpoint && status >= 400 && status < 500 && status !== 429) this.remember(model, { refused: endpoint })
    else if (!endpointFailed(error)) return false
    return this.routesFor(model).some((candidate) => !tried.has(candidate))
  }

  private async *streamChat(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)

    let res: Response
    try {
      res = await this.open(request, options?.headers, signal)
    } catch (err) {
      clear()
      throw normalizeUnknownError(this.id, err)
    }

    try {
      yield { type: 'start', provider: this.id, model: request.model }
      let usage: Usage | undefined
      // A stream that ends with neither a finish reason nor [DONE] was cut off, however quietly the connection closed.
      let finished = false
      // Some servers omit `index` on tool-call deltas; key them by id instead,
      // and attach id-less continuation deltas to the last call seen.
      const indexById = new Map<string, number>()
      let lastIndex = 0
      let sawNativeReasoning = false
      const thinkParser = createThinkTagParser()
      for await (const { data } of parseSSEJson<ChatChunk>(res.body, { signal, onActivity: options?.onActivity, onDone: () => { finished = true } })) {
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
            finished = true
            for (const event of thinkParser.flush()) yield event
            yield { type: 'stop', stopReason: mapFinishReason(choice.finish_reason) }
          }
        }
        const u = mapChatUsage(data.usage ?? choice?.usage)
        if (u) usage = mergeUsage(usage, u)
      }
      if (!finished && !signal.aborted) throw streamEndedEarly(this.id)
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
