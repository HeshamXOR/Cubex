import Anthropic, { APIError } from '@anthropic-ai/sdk'
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
import {
  isThinkingHistoryError,
  mapAnthUsage,
  mapStopReason,
  toAnthropicParams,
  withoutThinking,
  type AnthParams
} from './translate'

const CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'json_mode',
  'vision',
  'image_input',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

/**
 * Static model list. Anthropic's v0.32 SDK has no `models.list()` resource, so
 * this catalogue is maintained here (context windows per Anthropic docs).
 */
interface StaticModel {
  id: string
  displayName: string
  family: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  /** 1M window requires the context-1m beta header (older Sonnet 4.x). */
  longContext?: boolean
}
// Static fallback catalogue used when the live models endpoint is unreachable.
// `reasoning` marks families that accept adaptive thinking + effort.
// `longContext` marks models whose 1M window needs the context-1m beta header;
// current models (Fable 5.1 / Opus 5 / Sonnet 5) have 1M natively (no header).
const STATIC_MODELS: StaticModel[] = [
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', family: 'claude-fable-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', family: 'claude-opus-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', family: 'claude-sonnet-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', family: 'claude-haiku-4-5', contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: false },
  // Legacy (still served)
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', family: 'claude-opus-4', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', family: 'claude-sonnet-4', contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoning: true, longContext: true }
]

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/** The static entry of the longest family a model id belongs to ("claude-sonnet-5-5" belongs to "claude-sonnet-5"). */
function familyOf(id: string): StaticModel | undefined {
  let best: StaticModel | undefined
  for (const model of STATIC_MODELS) {
    const inFamily = id === model.family || id.startsWith(`${model.family}-`)
    if (inFamily && (!best || model.family.length > best.family.length)) best = model
  }
  return best
}

/**
 * Anthropic adapter using the official `@anthropic-ai/sdk`. Translates the
 * unified request into the NATIVE Messages format (see ./translate).
 */
export class AnthropicProvider extends BaseProvider {
  readonly kind: ProviderKind = 'anthropic'
  readonly id: string
  readonly name: string

  private readonly client: Anthropic

  constructor(
    private readonly cfg: ProviderConfig,
    secret?: string
  ) {
    super()
    this.id = cfg.id
    this.name = cfg.name
    this.client = new Anthropic({
      apiKey: secret ?? 'missing',
      // Trim a trailing slash so a base URL like "https://host/" doesn't
      // produce "https://host//v1/messages" against strict proxies.
      // Always explicit: otherwise the SDK reads ANTHROPIC_BASE_URL /
      // ANTHROPIC_AUTH_TOKEN from the environment (common with CLI proxies) and
      // would send this provider's stored key somewhere the user never chose.
      baseURL: cfg.baseUrl ? normalizeBaseUrl(cfg.baseUrl, cfg.baseUrl) : 'https://api.anthropic.com',
      authToken: null,
      dangerouslyAllowBrowser: false,
      // The gateway's RetryEngine is the single retry layer; SDK retries would
      // multiply attempts and ignore the user's retry settings.
      maxRetries: 0
    })
    this.setCapabilities(cfg.capabilities ?? CAPS)
  }

  /**
   * Extra headers for a request. A 1M window that sits behind a beta (older Sonnet 4.x, and any model the
   * person declared as offering one) needs the `context-1m` beta header. The caller opts in per request with
   * `x-cubex-long-context: 1`, or the provider config does with the same header.
   */
  private betaHeaders(base?: Record<string, string>): Record<string, string> | undefined {
    const wantLong = base?.['x-cubex-long-context'] === '1' || this.cfg.headers?.['x-cubex-long-context'] === '1'
    const headers: Record<string, string> = { ...base }
    delete headers['x-cubex-long-context']
    // The caller only opts in for a model offered with a 1M window (a known gated model, one the person
    // declared on the provider, or one the endpoint reports), so the header needs no allow-list here.
    if (wantLong) {
      headers['anthropic-beta'] = ['context-1m-2025-08-07', headers['anthropic-beta']].filter(Boolean).join(',')
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  private staticModels(): ModelInfo[] {
    return STATIC_MODELS.map((m) => ({
      id: m.id,
      providerId: this.id,
      displayName: m.displayName,
      family: m.family,
      location: 'cloud' as const,
      capabilities: m.reasoning ? CAPS : CAPS.filter((c) => c !== 'reasoning'),
      modalities: { input: ['text', 'image'], output: ['text'] },
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsReasoning: m.reasoning,
      ...(m.longContext ? { longContextBeta: true } : {})
    }))
  }

  async getModels(): Promise<ModelInfo[]> {
    // Prefer the live models endpoint; fall back to the static catalogue.
    try {
      const list = await this.client.models.list({ limit: 100 })
      const known = new Map(STATIC_MODELS.map((m) => [m.id, m]))
      const models: ModelInfo[] = []
      for (const m of list.data) {
        const exact = known.get(m.id)
        // A model this list has never seen (a point release, a relay's alias) is described by its family
        // for what a family settles: whether it reasons and how much it can write in one reply.
        const meta = exact ?? familyOf(m.id)
        const reportedWindow = positive(m.max_input_tokens)
        const reportedOutput = positive(m.max_tokens)
        const reasoning = m.capabilities?.thinking?.supported ?? meta?.reasoning ?? /fable-5|opus-5|opus-4|sonnet-5|sonnet-4|3-7-sonnet/.test(m.id)
        const maxOutputTokens = reportedOutput ?? meta?.maxOutputTokens
        models.push({
          id: m.id,
          providerId: this.id,
          displayName: m.display_name ?? m.id,
          location: 'cloud',
          capabilities: reasoning ? CAPS : CAPS.filter((c) => c !== 'reasoning'),
          modalities: { input: ['text', 'image'], output: ['text'] },
          contextWindow: reportedWindow ?? exact?.contextWindow ?? 200_000,
          // Left out when nothing says: a made-up cap would clamp every request to it.
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsReasoning: reasoning,
          ...(exact?.longContext ? { longContextBeta: true } : {})
        })
      }
      return models.length > 0 ? models : this.staticModels()
    } catch {
      return this.staticModels()
    }
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const signal = options?.signal
    if (signal?.aborted) throw this.abort()
    request = requestWithSupportedEffort(this.kind, request, {
      id: request.model,
      supportsReasoning: this.cfg.capabilities && !this.supports('reasoning')
        ? false : (STATIC_MODELS.find((model) => model.id === request.model) ?? familyOf(request.model))?.reasoning
    })

    const body = toAnthropicParams(request, true)
    // Automatic prompt caching: one top-level breakpoint that advances with the
    // conversation. An agent loop resends system + tools + history every
    // iteration, so cache reads (≈0.1× input price) dominate. Skipped for custom
    // base URLs, whose Anthropic-compatible proxies may reject unknown fields.
    if (!this.cfg.baseUrl && this.cfg.promptCaching !== false) body.cache_control = { type: 'ephemeral' }
    try {
      const headers = this.betaHeaders(options?.headers)
      const stream = await this.openStream(
        body,
        {
          ...(signal ? { signal } : {}), ...(headers ? { headers } : {}),
          timeout: sdkTimeoutMs(options?.timeout)
        }
      )

      let started = false
      let usage: Usage | undefined
      // Map Anthropic content-block index -> our tool_call index.
      const toolBlockIndex = new Map<number, number>()
      let nextToolIndex = 0
      // Thinking blocks carry a signature that must be replayed with tool results.
      const thinkingSignatures = new Map<number, string>()

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            started = true
            const id = event.message?.id
            usage = mapAnthUsage(event.message?.usage as Parameters<typeof mapAnthUsage>[0], usage)
            yield { type: 'start', provider: this.id, model: request.model, ...(id ? { requestId: id } : {}) }
            break
          }
          case 'content_block_start': {
            const block = event.content_block
            if ((block as { type: string }).type === 'redacted_thinking') {
              yield { type: 'metadata', data: { reasoningBlock: { redacted: (block as unknown as { data: string }).data } } }
            } else if (block.type === 'thinking') {
              thinkingSignatures.set(event.index, '')
            } else if (block.type === 'tool_use') {
              const idx = nextToolIndex++
              toolBlockIndex.set(event.index, idx)
              yield { type: 'tool_call_delta', index: idx, id: block.id, name: block.name }
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string; signature?: string }
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text ?? '' }
            } else if (delta.type === 'thinking_delta') {
              // Summarized adaptive-thinking tokens.
              yield { type: 'reasoning_delta', text: delta.thinking ?? '' }
            } else if (delta.type === 'signature_delta') {
              thinkingSignatures.set(event.index, (thinkingSignatures.get(event.index) ?? '') + (delta.signature ?? ''))
            } else if (delta.type === 'input_json_delta') {
              const idx = toolBlockIndex.get(event.index) ?? 0
              yield { type: 'tool_call_delta', index: idx, argsDelta: delta.partial_json ?? '' }
            }
            break
          }
          case 'content_block_stop': {
            const signature = thinkingSignatures.get(event.index)
            if (signature) yield { type: 'metadata', data: { reasoningBlock: { signature } } }
            break
          }
          case 'message_delta': {
            const evt = event as { usage?: Parameters<typeof mapAnthUsage>[0]; delta?: { stop_reason?: string | null } }
            usage = mapAnthUsage(evt.usage, usage)
            const stopReason = evt.delta?.stop_reason
            if (stopReason) yield { type: 'stop', stopReason: mapStopReason(stopReason) }
            break
          }
          case 'message_stop': {
            if (usage) yield { type: 'usage', usage }
            break
          }
          default:
            break
        }
      }
      if (!started) {
        // Defensive: emit a start so downstream never sees an empty stream.
        yield { type: 'start', provider: this.id, model: request.model }
      }
    } catch (err) {
      throw this.wrap(err)
    }
  }

  /**
   * Open the message stream. A 400 that says the history cannot carry thinking
   * (a block bound to another conversation or model, one the API says was
   * modified, or a tool turn written by another provider with none) is retried
   * once with thinking removed from the request, so a fallback or an edited
   * prefix costs this request its reasoning instead of failing the whole turn.
   * Every other error, and a second failure, propagates unchanged.
   */
  private async openStream(body: AnthParams, options: Parameters<Anthropic['messages']['create']>[1]) {
    const create = (params: AnthParams) =>
      this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsStreaming, options)
    try {
      return await create(body)
    } catch (err) {
      const retry = err instanceof APIError && err.status === 400 && isThinkingHistoryError(err.message)
        ? withoutThinking(body)
        : undefined
      if (!retry) throw err
      return create(retry)
    }
  }

  async validateConfiguration(): Promise<ValidationResult> {
    // Cheap validation: a 1-token message. Auth failures surface as 401.
    try {
      await this.client.messages.create(
        {
          model: this.cfg.defaultModel ?? 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        } as unknown as Anthropic.MessageCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(8000) }
      )
      return { ok: true, details: { models: STATIC_MODELS.length } }
    } catch (err) {
      const norm = this.wrap(err)
      if (norm.category === 'AUTHENTICATION_ERROR') {
        return { ok: false, message: 'Authentication failed: check the API key.' }
      }
      // A well-formed 400 (e.g. model quibble) still proves the key works.
      if (norm.statusCode === 400) return { ok: true, details: { note: 'Reachable; validation used a minimal request.' } }
      return { ok: false, message: `Validation failed: ${norm.message}` }
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

  private wrap(err: unknown): NormalizedAIError {
    if (err instanceof NormalizedAIError) return err
    if (err instanceof APIError) {
      const status = (err as APIError).status
      if (status === undefined) {
        const name = (err as { name?: string }).name
        if (name === 'APIUserAbortError') return this.abort()
        return normalizeUnknownError(this.id, err)
      }
      const headers = err.headers as unknown as Record<string, string> | undefined
      return normalizeHttpError({
        provider: this.id,
        status,
        ...(headers ? { headers } : {}),
        body: err.error,
        ...(err.requestID ? { requestId: err.requestID } : {}),
        message: err.message,
        cause: err
      })
    }
    return normalizeUnknownError(this.id, err)
  }
}
