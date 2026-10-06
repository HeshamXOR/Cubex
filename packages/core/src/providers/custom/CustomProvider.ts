import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { CustomProviderMapping, ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import { extractText } from '../../builders'
import { normalizeHttpError, normalizeUnknownError } from '../../errors/normalize'
import { parseSSEJson } from '../../streaming/sse'
import { chatFetchInit } from '../../util/chatFetch'
import { withTimeout } from '../../util/timeout'
import { BaseProvider, buildAuthHeaders, normalizeBaseUrl } from '../base'
import { OpenAICompatProvider } from '../openai-compat/OpenAICompatProvider'
import { AnthropicProvider } from '../anthropic/AnthropicProvider'

const DEFAULT_CAPS: Capability[] = ['text', 'streaming', 'system_prompt', 'multi_turn', 'cancellation']
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

function pathSegments(path: string): string[] {
  const segments = path.split('.')
  if (segments.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new TypeError('Mapping paths must contain nonempty fields and cannot use __proto__, constructor, or prototype.')
  }
  return segments
}

/** Read a value at a dot-path (e.g. "choices.0.text") from a nested object. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let segments: string[]
  try {
    segments = pathSegments(path)
  } catch {
    return undefined
  }
  let cur: unknown = obj
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= cur.length) return undefined
      cur = cur[Number(seg)]
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

/** Set a value at a dot-path, creating intermediate objects as needed. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return
  // Validate the whole path before creating anything, including intermediate fields.
  const segs = pathSegments(path)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string
    const existing = Object.hasOwn(cur, seg) ? cur[seg] : undefined
    if (existing == null || typeof existing !== 'object') {
      Object.defineProperty(cur, seg, { value: {}, writable: true, enumerable: true, configurable: true })
    }
    cur = cur[seg] as Record<string, unknown>
  }
  const last = segs[segs.length - 1] as string
  Object.defineProperty(cur, last, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * Generic Custom provider driven by a declarative `CustomProviderMapping`.
 *  - shape 'openai'    -> delegate to OpenAICompatProvider
 *  - shape 'anthropic' -> delegate to AnthropicProvider
 *  - shape 'rest'      -> build/extract via dot-paths (default)
 */
export class CustomProvider extends BaseProvider {
  readonly kind: ProviderKind = 'custom'
  readonly id: string
  readonly name: string

  private readonly baseUrl: string
  private readonly mapping: CustomProviderMapping
  private readonly delegate?: OpenAICompatProvider | AnthropicProvider
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly secret?: string
  ) {
    super()
    this.id = cfg.id
    this.name = cfg.name
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl, '')
    this.mapping = cfg.mapping ?? {}
    this.setCapabilities(cfg.capabilities ?? DEFAULT_CAPS)
    this.fetchImpl = globalThis.fetch

    if (this.mapping.shape === 'openai') {
      this.delegate = new OpenAICompatProvider(cfg, secret)
    } else if (this.mapping.shape === 'anthropic') {
      this.delegate = new AnthropicProvider(cfg, secret)
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    if (this.delegate) return this.delegate.getModels()
    const fallback = this.cfg.defaultModel
    return fallback
      ? [
          {
            id: fallback,
            providerId: this.id,
            displayName: fallback,
            location: 'cloud',
            capabilities: this.cfg.capabilities ?? DEFAULT_CAPS,
            modalities: { input: ['text'], output: ['text'] },
            supportsTools: false,
            supportsStructuredOutput: false,
            supportsReasoning: false
          }
        ]
      : []
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    if (this.delegate) {
      yield* this.delegate.streamMessage(request, options)
      return
    }
    yield* this.streamRest(request, options)
  }

  /** REST shape: build a body via dot-paths, extract text via responseTextPath. */
  private async *streamRest(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const signal0 = options?.signal
    if (signal0?.aborted) throw this.abort()
    this.validateMapping()

    const method = this.mapping.method ?? 'POST'
    const streaming = this.mapping.sse === true
    const { signal, clear } = withTimeout(options?.timeout, options?.signal)

    try {
      // Assemble the request body from the mapping's dot-paths.
      const promptText = this.buildPromptText(request)
      const body: Record<string, unknown> = {}
      if (this.mapping.promptField) setPath(body, this.mapping.promptField, promptText)
      if (this.mapping.modelField) setPath(body, this.mapping.modelField, request.model)
      if (this.mapping.streamField) setPath(body, this.mapping.streamField, streaming)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(this.cfg, this.secret),
        ...(options?.headers ?? {})
      }

      const res = await this.fetchImpl(this.baseUrl, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal,
        ...chatFetchInit()
      })
      if (!res.ok) throw await this.httpError(res)

      yield { type: 'start', provider: this.id, model: request.model }
      const textPath = this.mapping.responseTextPath ?? 'text'

      if (streaming) {
        for await (const { data } of parseSSEJson(res.body, { signal, onActivity: options?.onActivity })) {
          const chunk = getPath(data, textPath)
          if (typeof chunk === 'string' && chunk) yield { type: 'text_delta', text: chunk }
        }
        yield { type: 'stop', stopReason: 'stop' }
      } else {
        // Single JSON response -> synthesize a completed stream.
        const json = await res.json()
        const text = getPath(json, textPath)
        if (typeof text === 'string' && text) yield { type: 'text_delta', text }
        yield { type: 'stop', stopReason: 'stop' }
      }
    } catch (err) {
      throw normalizeUnknownError(this.id, err)
    } finally {
      clear()
    }
  }

  private validateMapping(): void {
    for (const field of ['promptField', 'modelField', 'streamField', 'responseTextPath'] as const) {
      const path = this.mapping[field]
      if (!path) continue
      try {
        pathSegments(path)
      } catch (cause) {
        throw new NormalizedAIError({
          provider: this.id,
          category: 'INVALID_REQUEST',
          message: `Invalid custom provider ${field}. ${(cause as Error).message}`,
          classification: 'permanent',
          retryable: false,
          cause
        })
      }
    }
  }

  /** Flatten the conversation into a single prompt string for REST endpoints. */
  private buildPromptText(request: AIRequest): string {
    const parts: string[] = []
    if (request.system !== undefined) {
      const sys = typeof request.system === 'string' ? request.system : extractText(request.system)
      if (sys) parts.push(sys)
    }
    for (const m of request.messages) {
      const text = extractText(m.content)
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }

  async validateConfiguration(): Promise<ValidationResult> {
    if (this.delegate) return this.delegate.validateConfiguration()
    if (!this.baseUrl) return { ok: false, message: 'No baseUrl configured for custom provider.' }
    try {
      this.validateMapping()
    } catch (err) {
      return { ok: false, message: normalizeUnknownError(this.id, err).message }
    }
    // Best-effort reachability: a GET (or HEAD) to the endpoint.
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'GET',
        headers: buildAuthHeaders(this.cfg, this.secret),
        signal: AbortSignal.timeout(6000)
      })
      // Any HTTP response (even 4xx/405) proves the endpoint is reachable.
      return { ok: true, details: { endpoint: this.baseUrl, status: res.status } }
    } catch (err) {
      const norm = normalizeUnknownError(this.id, err)
      return { ok: false, message: `Endpoint not reachable: ${norm.message}` }
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

  private async httpError(res: Response): Promise<NormalizedAIError> {
    let body: unknown
    const text = await res.text().catch(() => '')
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return normalizeHttpError({ provider: this.id, status: res.status, headers: res.headers, body })
  }
}
