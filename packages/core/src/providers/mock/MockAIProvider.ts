import { nanoid } from 'nanoid'
import { ALL_CAPABILITIES, type Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import { BaseProvider } from '../base'
import { extractText } from '../../builders'

/** Deterministic scenarios the mock can simulate — drives the whole test suite. */
export type MockScenario =
  | 'normal'
  | 'slow'
  | 'timeout'
  | 'rate_limit' // 429 with Retry-After
  | 'server_error' // 500
  | 'invalid_request' // 400 (permanent)
  | 'auth_error' // 401 (permanent)
  | 'tool_call'
  | 'fail_then_succeed' // fails `failuresBeforeSuccess` times, then succeeds

export interface MockConfig {
  id?: string
  name?: string
  scenario?: MockScenario
  /** Text the mock "generates". */
  reply?: string
  /** Tokens per stream chunk. */
  chunkSize?: number
  /** Delay between chunks (ms). */
  chunkDelayMs?: number
  /** For rate_limit: seconds to advertise in Retry-After. */
  retryAfterSeconds?: number
  /** For fail_then_succeed. */
  failuresBeforeSuccess?: number
  capabilities?: Capability[]
  models?: ModelInfo[]
}

/**
 * A fully working provider that never touches the network. It exercises the
 * entire gateway/retry/fallback/streaming pipeline deterministically.
 */
export class MockAIProvider extends BaseProvider {
  readonly kind: ProviderKind = 'mock'
  readonly id: string
  readonly name: string

  private scenario: MockScenario
  private reply: string
  private chunkSize: number
  private chunkDelayMs: number
  private retryAfterSeconds: number
  private failuresBeforeSuccess: number
  private attemptCounter = 0
  private readonly models: ModelInfo[]

  constructor(cfg: MockConfig = {}) {
    super()
    this.id = cfg.id ?? 'mock'
    this.name = cfg.name ?? 'Mock Provider'
    this.scenario = cfg.scenario ?? 'normal'
    this.reply = cfg.reply ?? 'Hello from the mock provider.'
    this.chunkSize = cfg.chunkSize ?? 4
    this.chunkDelayMs = cfg.chunkDelayMs ?? 0
    this.retryAfterSeconds = cfg.retryAfterSeconds ?? 1
    this.failuresBeforeSuccess = cfg.failuresBeforeSuccess ?? 1
    this.setCapabilities(cfg.capabilities ?? ALL_CAPABILITIES)
    this.models =
      cfg.models ?? [
        {
          id: 'mock-large',
          providerId: this.id,
          displayName: 'Mock Large',
          location: 'cloud',
          capabilities: ALL_CAPABILITIES,
          modalities: { input: ['text', 'image'], output: ['text'] },
          contextWindow: 128_000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsReasoning: true,
          pricing: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 3 }
        }
      ]
  }

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario
    this.attemptCounter = 0
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.models
  }

  async validateConfiguration(): Promise<ValidationResult> {
    if (this.scenario === 'auth_error') {
      return { ok: false, message: 'Mock authentication error' }
    }
    return { ok: true, message: 'Mock provider ready', details: { models: this.models.length } }
  }

  private err(scenario: MockScenario): NormalizedAIError {
    switch (scenario) {
      case 'rate_limit':
        return new NormalizedAIError({
          provider: this.id,
          category: 'RATE_LIMIT_ERROR',
          message: 'Rate limited (mock)',
          classification: 'transient',
          statusCode: 429,
          retryable: true,
          retryAfterMs: this.retryAfterSeconds * 1000,
          rawCode: 'rate_limit_exceeded'
        })
      case 'server_error':
        return new NormalizedAIError({
          provider: this.id,
          category: 'SERVER_ERROR',
          message: 'Internal server error (mock)',
          classification: 'transient',
          statusCode: 500,
          retryable: true
        })
      case 'timeout':
        return new NormalizedAIError({
          provider: this.id,
          category: 'TIMEOUT',
          message: 'Request timed out (mock)',
          classification: 'transient',
          retryable: true
        })
      case 'invalid_request':
        return new NormalizedAIError({
          provider: this.id,
          category: 'INVALID_REQUEST',
          message: 'Invalid request (mock)',
          classification: 'permanent',
          statusCode: 400,
          retryable: false
        })
      case 'auth_error':
        return new NormalizedAIError({
          provider: this.id,
          category: 'AUTHENTICATION_ERROR',
          message: 'Invalid API key (mock)',
          classification: 'permanent',
          statusCode: 401,
          retryable: false,
          rawCode: 'invalid_api_key'
        })
      default:
        return new NormalizedAIError({
          provider: this.id,
          category: 'UNKNOWN',
          message: 'Unknown mock error',
          classification: 'unknown',
          retryable: false
        })
    }
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    this.attemptCounter += 1
    const signal = options?.signal

    // Error scenarios throw before any content.
    if (['rate_limit', 'server_error', 'timeout', 'invalid_request', 'auth_error'].includes(this.scenario)) {
      throw this.err(this.scenario)
    }
    if (this.scenario === 'fail_then_succeed' && this.attemptCounter <= this.failuresBeforeSuccess) {
      throw this.err('server_error')
    }

    const requestId = `mock_${nanoid(8)}`
    yield { type: 'start', provider: this.id, model: request.model, requestId }

    if (this.scenario === 'tool_call') {
      const id = `call_${nanoid(6)}`
      yield { type: 'tool_call_delta', index: 0, id, name: 'get_weather' }
      yield { type: 'tool_call_delta', index: 0, argsDelta: '{"location":' }
      yield { type: 'tool_call_delta', index: 0, argsDelta: '"Paris"}' }
      yield { type: 'tool_call', toolCall: { id, name: 'get_weather', input: { location: 'Paris' } } }
      yield { type: 'stop', stopReason: 'tool_use' }
      yield {
        type: 'usage',
        usage: { inputTokens: countTokens(extractText(request.messages.at(-1)?.content ?? [])), outputTokens: 8, totalTokens: 0 }
      }
      return
    }

    const delay = this.scenario === 'slow' ? Math.max(this.chunkDelayMs, 40) : this.chunkDelayMs
    const words = this.reply.match(/\S+\s*/g) ?? [this.reply]
    let buffer = ''
    let emitted = 0
    for (const w of words) {
      buffer += w
      emitted += 1
      if (emitted % this.chunkSize === 0) {
        if (signal?.aborted) throw abortError(this.id)
        yield { type: 'text_delta', text: buffer }
        buffer = ''
        if (delay > 0) await sleep(delay, signal)
      }
    }
    if (buffer) {
      if (signal?.aborted) throw abortError(this.id)
      yield { type: 'text_delta', text: buffer }
    }

    const inputTokens = request.messages.reduce((n, m) => n + countTokens(extractText(m.content)), 0)
    const outputTokens = countTokens(this.reply)
    yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
    yield { type: 'stop', stopReason: 'stop' }
  }
}

function countTokens(text: string): number {
  // Rough heuristic; the mock is not a tokenizer.
  return Math.max(1, Math.ceil(text.length / 4))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(abortError('mock'))
    }, { once: true })
  })
}

function abortError(provider: string): NormalizedAIError {
  return new NormalizedAIError({
    provider,
    category: 'CANCELLED',
    message: 'Generation stopped',
    classification: 'permanent',
    retryable: false
  })
}
