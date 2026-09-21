import Anthropic, { APIError } from '@anthropic-ai/sdk'
import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import type { Usage } from '../../types/response'
import { normalizeHttpError, normalizeUnknownError } from '../../errors/normalize'
import { BaseProvider } from '../base'
import { mapAnthUsage, mapStopReason, toAnthropicParams } from './translate'

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
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      dangerouslyAllowBrowser: false
    })
    this.setCapabilities(cfg.capabilities ?? CAPS)
  }

  /**
   * Extra headers for a request. Models whose 1M window is gated behind a beta
   * (older Sonnet 4.x) need the `context-1m` beta header; current models have 1M
   * natively. Enabled when the model is a known long-context-beta model AND the
   * provider config opts in via headers['x-cubex-long-context'] === '1'.
   */
  private betaHeaders(model: string, base?: Record<string, string>): Record<string, string> | undefined {
    const meta = STATIC_MODELS.find((m) => m.id === model)
    const wantLong = base?.['x-cubex-long-context'] === '1' || this.cfg.headers?.['x-cubex-long-context'] === '1'
    const headers: Record<string, string> = { ...base }
    delete headers['x-cubex-long-context']
    if (meta?.longContext && wantLong) {
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
        const meta = known.get(m.id)
        const reasoning = meta?.reasoning ?? /fable-5|opus-5|opus-4|sonnet-5|sonnet-4|3-7-sonnet/.test(m.id)
        models.push({
          id: m.id,
          providerId: this.id,
          displayName: m.display_name ?? m.id,
          location: 'cloud',
          capabilities: reasoning ? CAPS : CAPS.filter((c) => c !== 'reasoning'),
          modalities: { input: ['text', 'image'], output: ['text'] },
          contextWindow: meta?.contextWindow ?? 200_000,
          maxOutputTokens: meta?.maxOutputTokens ?? 8_192,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsReasoning: reasoning,
          ...(meta?.longContext ? { longContextBeta: true } : {})
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

    const body = toAnthropicParams(request, true)
    try {
      const headers = this.betaHeaders(request.model, options?.headers)
      const stream = await this.client.messages.create(
        body as unknown as Anthropic.MessageCreateParamsStreaming,
        { ...(signal ? { signal } : {}), ...(headers ? { headers } : {}) }
      )

      let started = false
      let usage: Usage | undefined
      // Map Anthropic content-block index -> our tool_call index.
      const toolBlockIndex = new Map<number, number>()
      let nextToolIndex = 0

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
            if (block.type === 'tool_use') {
              const idx = nextToolIndex++
              toolBlockIndex.set(event.index, idx)
              yield { type: 'tool_call_delta', index: idx, id: block.id, name: block.name }
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text }
            } else if (delta.type === 'input_json_delta') {
              const idx = toolBlockIndex.get(event.index) ?? 0
              yield { type: 'tool_call_delta', index: idx, argsDelta: delta.partial_json }
            }
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
