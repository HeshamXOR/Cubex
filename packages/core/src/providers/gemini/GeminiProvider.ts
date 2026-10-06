import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIResponse } from '../../types/response'
import type { AIStreamEvent } from '../../types/stream'
import { normalizeUnknownError } from '../../errors/normalize'
import { StreamAccumulator } from '../../streaming/accumulator'
import { parseSSEJson } from '../../streaming/sse'
import { chatFetchInit } from '../../util/chatFetch'
import { withTimeout } from '../../util/timeout'
import { BaseProvider, normalizeBaseUrl } from '../base'
import { requestWithSupportedEffort } from '../effort'
import { normalizeGeminiError } from './errors'
import { withoutGeminiSignatures } from './replay'
import { GeminiStreamMapper, type GemChunk } from './stream'
import { geminiThinkingProfile } from './thinking'
import { isGemmaModel, toGeminiRequest, type GemRequest } from './translate'

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_API_VERSION = 'v1beta'

const CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'structured_output',
  'json_mode',
  'reasoning',
  'vision',
  'image_input',
  'file_input',
  'audio_input',
  'video_input',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

/** Speech, image generation, realtime and embedding models answer generateContent but are not chat models. */
const NOT_FOR_CHAT = /(^|-)(tts|image|imagen|live|native-audio|embedding|veo|aqa)(-|$)/

/** The stable models, shown when the models endpoint cannot be reached. */
const FALLBACK_MODELS = [
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite' },
  { id: 'gemini-flash-latest', displayName: 'Gemini Flash (latest)' }
]

const MAX_MODEL_PAGES = 5
const LIST_TIMEOUT_MS = 15_000
const VALIDATE_TIMEOUT_MS = 8_000

/** A model as the models endpoint returns it (the fields this adapter reads). */
interface GemModel {
  name?: string
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: string[]
  thinking?: boolean
}

export interface GeminiProviderOptions {
  /** Injected in tests; defaults to the global `fetch`, resolved at call time. */
  fetch?: typeof fetch
}

/** `models/x` and `tunedModels/x` pass through; a bare id is a base model. */
function modelPath(model: string): string {
  const match = /^(models|tunedModels)\/(.+)$/.exec(model)
  return match ? `${match[1]}/${encodeURIComponent(match[2]!)}` : `models/${encodeURIComponent(model)}`
}

/** A base that already names the API version is used as it is. A blank base URL is "not set". */
function apiBaseFor(cfg: ProviderConfig): string {
  const base = normalizeBaseUrl(cfg.baseUrl?.trim() || undefined, GEMINI_DEFAULT_BASE_URL)
  return /\/v\d+(?:alpha|beta)?\d*$/.test(base) ? base : `${base}/${cfg.apiVersion ?? DEFAULT_API_VERSION}`
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  headers[name] = value
}

const TIERS: Record<string, number> = { pro: 0, flash: 1, 'flash-lite': 2 }

/** Newest generation first, then Pro before Flash; aliases and other models after. */
function compareModels(a: ModelInfo, b: ModelInfo): number {
  const rank = (id: string): [number, number, number] => {
    const match = /^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)/.exec(id)
    if (match) return [0, -Number(match[1]), TIERS[match[2]!] ?? 3]
    return [id.startsWith('gemini-') ? 1 : 2, 0, 0]
  }
  const [ga, gb] = [rank(a.id), rank(b.id)]
  for (let i = 0; i < 3; i++) if (ga[i] !== gb[i]) return ga[i]! - gb[i]!
  return a.id.localeCompare(b.id)
}

/**
 * Native adapter for the Google Gemini API (`generativelanguage.googleapis.com`),
 * over raw `fetch` + SSE (no SDK). Speaks `generateContent` /
 * `streamGenerateContent` directly, so thinking, thought signatures and function
 * calls use Gemini's own wire format. The key goes in the `x-goog-api-key`
 * header: it never appears in a URL, an error message or a log line.
 */
export class GeminiProvider extends BaseProvider {
  readonly kind: ProviderKind = 'gemini'
  readonly id: string
  readonly name: string

  private readonly apiBase: string
  private readonly fetchOverride: typeof fetch | undefined
  /** Models seen by getModels(), for the `thinking` flag an id alone cannot give. */
  private readonly known = new Map<string, ModelInfo>()
  /** Models whose API refused the thinking parameters; they are sent none from then on. */
  private readonly thinkingRefused = new Set<string>()

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly secret?: string,
    options: GeminiProviderOptions = {}
  ) {
    super()
    this.id = cfg.id
    this.name = cfg.name
    this.apiBase = apiBaseFor(cfg)
    this.fetchOverride = options.fetch
    this.setCapabilities(cfg.capabilities ?? CAPS)
  }

  private fetchFn(): typeof fetch {
    return this.fetchOverride ?? globalThis.fetch
  }

  // --- Models ---

  async getModels(): Promise<ModelInfo[]> {
    try {
      const listed = await this.listModels(AbortSignal.timeout(LIST_TIMEOUT_MS))
      const models = listed
        .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => this.toModelInfo(m))
        .filter((m) => !NOT_FOR_CHAT.test(m.id))
        .sort(compareModels)
      if (models.length > 0) {
        this.known.clear()
        for (const model of models) this.known.set(model.id, model)
        return models
      }
    } catch {
      // fall through to the static list
    }
    return FALLBACK_MODELS.map((m) =>
      this.toModelInfo({
        name: `models/${m.id}`,
        displayName: m.displayName,
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536
      }, 'Static fallback list (models endpoint unavailable)')
    )
  }

  private async listModels(signal: AbortSignal): Promise<GemModel[]> {
    const models: GemModel[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const url = `${this.apiBase}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      const res = await this.fetchFn()(url, { headers: this.headers(undefined, false), signal })
      if (!res.ok) throw await this.httpError(res)
      const json = (await res.json()) as { models?: GemModel[]; nextPageToken?: string }
      models.push(...(json.models ?? []))
      pageToken = json.nextPageToken
      if (!pageToken) break
    }
    return models
  }

  private toModelInfo(m: GemModel, notes?: string): ModelInfo {
    const id = (m.name ?? '').replace(/^models\//, '')
    const reasoning = typeof m.thinking === 'boolean' ? m.thinking : geminiThinkingProfile(id) !== undefined
    const gemma = isGemmaModel(id)
    const caps = CAPS.filter((c) => (c !== 'reasoning' || reasoning) && (c !== 'tools' || !gemma))
    const family = /^(gemini-\d+(?:\.\d+)?)/.exec(id)?.[1] ?? (gemma ? 'gemma' : undefined)
    return {
      id,
      providerId: this.id,
      displayName: m.displayName || id,
      ...(family ? { family } : {}),
      location: 'cloud',
      capabilities: caps,
      modalities: { input: ['text', 'image', 'audio', 'video', 'file'], output: ['text'] },
      ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}),
      ...(m.outputTokenLimit ? { maxOutputTokens: m.outputTokenLimit } : {}),
      supportsTools: !gemma,
      supportsStructuredOutput: true,
      supportsReasoning: reasoning,
      ...(notes ? { notes } : {})
    }
  }

  // --- Requests ---

  /** Whether the model is known to think: declared capabilities, a refusal, then the models endpoint. */
  private thinkingFlag(model: string): boolean | undefined {
    if (this.cfg.capabilities && !this.supports('reasoning')) return false
    if (this.thinkingRefused.has(model)) return false
    return this.known.get(model.replace(/^models\//, ''))?.supportsReasoning
  }

  /** Validate, normalize the effort for the model, and build the native body. */
  private prepare(request: AIRequest): { model: string; body: GemRequest } {
    this.assertCredential()
    if (request.tools?.length && isGemmaModel(request.model)) {
      throw new NormalizedAIError({
        provider: this.id,
        category: 'INVALID_REQUEST',
        message: 'Gemma models on the Gemini API do not support tool calling. Choose a Gemini model.',
        classification: 'permanent',
        retryable: false
      })
    }
    const supportsThinking = this.thinkingFlag(request.model)
    const supported = requestWithSupportedEffort(this.kind, request, {
      id: request.model,
      ...(supportsThinking !== undefined ? { supportsReasoning: supportsThinking } : {})
    })
    return {
      model: request.model,
      body: toGeminiRequest(supported, supportsThinking !== undefined ? { supportsThinking } : {})
    }
  }

  private get needsCredential(): boolean {
    return this.cfg.auth.type !== 'none' && this.cfg.auth.type !== 'custom_headers'
  }

  private assertCredential(): void {
    if (this.secret || !this.needsCredential) return
    throw new NormalizedAIError({
      provider: this.id,
      category: 'AUTHENTICATION_ERROR',
      message: 'No Gemini API key is configured. Add one in the provider settings.',
      classification: 'permanent',
      retryable: false
    })
  }

  /**
   * Request headers. The credential is applied last so neither configured nor
   * per-call headers can displace it, and harness-only `x-cubex-*` headers are
   * never sent to Google. An OAuth token is a bearer credential; an API key is
   * not (Google rejects a key sent as a bearer token).
   */
  private headers(extra?: Record<string, string>, json = true): Record<string, string> {
    const headers: Record<string, string> = { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(this.cfg.headers ?? {}) }
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (!/^x-cubex-/i.test(key)) setHeader(headers, key, value)
    }
    if (this.secret) {
      const bearer = this.cfg.auth.type === 'oauth' || this.cfg.auth.type === 'bearer'
      if (bearer) setHeader(headers, 'Authorization', `Bearer ${this.secret}`)
      else setHeader(headers, 'x-goog-api-key', this.secret)
    }
    return headers
  }

  private url(model: string, method: 'generateContent' | 'streamGenerateContent'): string {
    const base = `${this.apiBase}/${modelPath(model)}:${method}`
    return method === 'streamGenerateContent' ? `${base}?alt=sse` : base
  }

  /**
   * POST the request. When the API names something it cannot take, ask once more
   * without it: thinking parameters a model refuses (the table in thinking.ts can
   * lag the models), or a thought signature it will not accept (one issued by
   * another model after a fallback). Resolves with an OK response; any other
   * outcome throws.
   */
  private async open(
    method: 'generateContent' | 'streamGenerateContent',
    request: AIRequest,
    options: RequestOptions | undefined,
    signal: AbortSignal
  ): Promise<Response> {
    let current = request
    for (let attempt = 0; ; attempt++) {
      const { model, body } = this.prepare(current)
      const res = await this.fetchFn()(this.url(model, method), {
        method: 'POST',
        headers: this.headers(options?.headers),
        body: JSON.stringify(body),
        signal,
        ...chatFetchInit()
      })
      if (res.ok) return res
      const error = await this.httpError(res)
      const repaired = attempt === 0 ? this.repair(current, body, error) : undefined
      if (!repaired) throw error
      current = repaired
    }
  }

  /** The request to try again with, or undefined when the error is not one that can be repaired. */
  private repair(request: AIRequest, body: GemRequest, error: NormalizedAIError): AIRequest | undefined {
    if (error.statusCode !== 400) return undefined
    if (/signature/i.test(error.message)) {
      const stripped = withoutGeminiSignatures(request)
      return stripped === request ? undefined : stripped
    }
    if (body.generationConfig?.thinkingConfig && /thinking|thought/i.test(error.message)) {
      this.thinkingRefused.add(request.model)
      return request
    }
    return undefined
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    if (options?.signal?.aborted) throw this.cancelled()
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)

    let res: Response
    try {
      res = await this.open('streamGenerateContent', request, options, signal)
    } catch (err) {
      clear()
      throw this.wrap(err, signal)
    }

    try {
      const mapper = new GeminiStreamMapper(this.id, request.model)
      for await (const { data } of parseSSEJson<GemChunk>(res.body, { signal, onActivity: options?.onActivity })) {
        yield* mapper.push(data)
      }
      // The SSE reader ends quietly on abort; that must not look like a finished answer.
      if (signal.aborted) throw this.wrap(undefined, signal)
      yield* mapper.end()
    } catch (err) {
      throw this.wrap(err, signal)
    } finally {
      clear()
    }
  }

  /** A real non-streaming call (`generateContent`), mapped by the same code as the stream. */
  override async sendMessage(request: AIRequest, options?: RequestOptions): Promise<AIResponse> {
    if (options?.signal?.aborted) throw this.cancelled()
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)
    try {
      const res = await this.open('generateContent', request, options, signal)
      let json: GemChunk | GemChunk[]
      try {
        json = (await res.json()) as GemChunk | GemChunk[]
      } catch {
        throw new NormalizedAIError({
          provider: this.id,
          category: 'STREAM_ERROR',
          message: 'Gemini returned a response that could not be read.',
          classification: 'transient',
          retryable: true
        })
      }
      const mapper = new GeminiStreamMapper(this.id, request.model)
      const acc = new StreamAccumulator(this.id, request.model)
      for (const chunk of Array.isArray(json) ? json : [json]) for (const event of mapper.push(chunk)) acc.push(event)
      for (const event of mapper.end()) acc.push(event)
      return acc.finalize()
    } catch (err) {
      throw this.wrap(err, signal)
    } finally {
      clear()
    }
  }

  async validateConfiguration(): Promise<ValidationResult> {
    if (!this.secret && this.needsCredential) {
      return { ok: false, message: 'No API key is set. Add one in the provider settings.' }
    }
    try {
      const listed = await this.listModels(AbortSignal.timeout(VALIDATE_TIMEOUT_MS))
      const chat = listed.filter((m) => m.supportedGenerationMethods?.includes('generateContent') && !NOT_FOR_CHAT.test(m.name ?? ''))
      return { ok: true, details: { endpoint: this.apiBase, models: chat.length } }
    } catch (err) {
      const error = err instanceof NormalizedAIError ? err : normalizeUnknownError(this.id, err)
      if (error.category === 'AUTHENTICATION_ERROR') return { ok: false, message: 'Authentication failed: check the API key.' }
      if (error.statusCode !== undefined) return { ok: false, message: `Validation failed: ${error.message}` }
      return { ok: false, message: `Not reachable at ${this.apiBase}: ${error.message}` }
    }
  }

  // --- Errors ---

  private cancelled(): NormalizedAIError {
    return new NormalizedAIError({
      provider: this.id,
      category: 'CANCELLED',
      message: 'Generation stopped',
      classification: 'permanent',
      retryable: false
    })
  }

  /** A thrown error as a normalized one; an aborted signal means cancelled or timed out, whatever was thrown. */
  private wrap(err: unknown, signal?: AbortSignal): NormalizedAIError {
    if (err instanceof NormalizedAIError) return err
    if (signal?.aborted) {
      const reason = signal.reason as { name?: string; message?: string } | undefined
      if (reason?.name === 'TimeoutError') {
        return new NormalizedAIError({
          provider: this.id,
          category: 'TIMEOUT',
          message: reason.message ?? 'Request timed out',
          classification: 'transient',
          retryable: true
        })
      }
      return this.cancelled()
    }
    return normalizeUnknownError(this.id, err)
  }

  private async httpError(res: Response): Promise<NormalizedAIError> {
    const text = await res.text().catch(() => '')
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      // not JSON (a proxy's error page): the text is used as the message
    }
    return normalizeGeminiError({ provider: this.id, status: res.status, headers: res.headers, body })
  }
}
