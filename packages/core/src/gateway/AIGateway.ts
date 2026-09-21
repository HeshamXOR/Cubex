import { NormalizedAIError } from '../types/errors'
import type { AIProvider } from '../types/provider'
import type { AIRequest, RequestOptions } from '../types/request'
import type { AIResponse } from '../types/response'
import type { AIStreamEvent } from '../types/stream'
import type {
  GatewayEvent,
  GatewayEventHandler,
  RoutingPolicy,
  RoutingTarget
} from '../types/routing'
import { withRetry, type RetryHooks } from '../retry/RetryEngine'
import { normalizeUnknownError } from '../errors/normalize'
import { StreamAccumulator } from '../streaming/accumulator'

/** Resolves a providerId to a live AIProvider instance. */
export type ProviderResolver = (providerId: string) => AIProvider | undefined

export interface GatewayCallOptions extends RequestOptions {
  onEvent?: GatewayEventHandler
  /** Test seams. */
  retryHooks?: Partial<RetryHooks>
}

/**
 * The single entry point the application uses. It:
 *  - resolves the primary target (and fallbacks, only if explicitly enabled)
 *  - wraps each provider call in the RetryEngine
 *  - emits lifecycle events (attempt / retry / fallback / final) for the UI
 *
 * The rest of the app never touches provider adapters directly.
 */
export class AIGateway {
  constructor(private readonly resolve: ProviderResolver) {}

  private buildTargets(policy: RoutingPolicy): RoutingTarget[] {
    return policy.fallbackEnabled ? [policy.primary, ...policy.fallbacks] : [policy.primary]
  }

  private requireProvider(target: RoutingTarget): AIProvider {
    const provider = this.resolve(target.providerId)
    if (!provider) {
      throw new NormalizedAIError({
        provider: target.providerId,
        category: 'INVALID_REQUEST',
        message: `Provider "${target.providerId}" is not configured or enabled.`,
        classification: 'permanent',
        retryable: false
      })
    }
    return provider
  }

  private mergeRequest(request: AIRequest, target: RoutingTarget): AIRequest {
    return {
      ...request,
      model: target.model,
      ...(target.params ? { params: { ...request.params, ...target.params } } : {})
    }
  }

  private retryHooksFor(
    target: RoutingTarget,
    policy: RoutingPolicy,
    opts: GatewayCallOptions
  ): RetryHooks {
    const emit = opts.onEvent
    const base: RetryHooks = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onRetry: ({ attempt, error, delayMs }) => {
        emit?.({ type: 'attempt_error', target, attempt, error, willRetry: true, delayMs })
        emit?.({ type: 'retry_wait', target, attempt, delayMs })
      },
      onGiveUp: ({ attempt, error }) => {
        emit?.({ type: 'attempt_error', target, attempt, error, willRetry: false })
      }
    }
    if (opts.retryHooks?.sleep) base.sleep = opts.retryHooks.sleep
    if (opts.retryHooks?.rand) base.rand = opts.retryHooks.rand
    return base
  }

  /** Non-streaming request with retry + optional fallback. */
  async send(
    request: AIRequest,
    policy: RoutingPolicy,
    opts: GatewayCallOptions = {}
  ): Promise<AIResponse> {
    const targets = this.buildTargets(policy)
    const emit = opts.onEvent
    let lastError: NormalizedAIError | undefined

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      if (i > 0 && lastError) {
        emit?.({
          type: 'fallback',
          from: targets[i - 1]!,
          to: target,
          reason: `${lastError.category}: ${lastError.message}`
        })
      }

      try {
        const provider = this.requireProvider(target)
        const req = this.mergeRequest(request, target)
        const response = await withRetry(
          async (attempt) => {
            emit?.({ type: 'attempt_start', target, attempt })
            try {
              return await provider.sendMessage(req, this.callOptions(policy, opts))
            } catch (err) {
              throw err instanceof NormalizedAIError ? err : normalizeUnknownError(provider.id, err)
            }
          },
          policy.retry,
          this.retryHooksFor(target, policy, opts)
        )
        emit?.({ type: 'final', target, success: true })
        return response
      } catch (err) {
        lastError = err instanceof NormalizedAIError ? err : normalizeUnknownError(target.providerId, err)
        // Do not fall back on permanent errors that a different model won't fix
        // in a way the user didn't ask for — but the user opted into fallback,
        // so we do try the next target for any error except explicit cancel.
        if (lastError.category === 'CANCELLED') break
        const hasNext = i < targets.length - 1
        if (!hasNext) {
          emit?.({ type: 'final', target, success: false })
        }
      }
    }
    throw lastError ?? new NormalizedAIError({
      provider: 'gateway',
      category: 'UNKNOWN',
      message: 'No routing targets available.',
      classification: 'permanent',
      retryable: false
    })
  }

  private callOptions(policy: RoutingPolicy, opts: GatewayCallOptions): RequestOptions {
    return {
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeout: { ...policy.timeout, ...opts.timeout },
      ...(opts.headers ? { headers: opts.headers } : {})
    }
  }

  /**
   * Streaming request. Retries happen only before the first token is emitted;
   * once bytes have streamed to the UI we cannot silently restart, so a mid-
   * stream failure surfaces as an error event (and may trigger fallback if no
   * content was produced yet).
   */
  async *stream(
    request: AIRequest,
    policy: RoutingPolicy,
    opts: GatewayCallOptions = {}
  ): AsyncGenerator<AIStreamEvent> {
    const targets = this.buildTargets(policy)
    const emit = opts.onEvent
    let lastError: NormalizedAIError | undefined

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      if (i > 0 && lastError) {
        emit?.({
          type: 'fallback',
          from: targets[i - 1]!,
          to: target,
          reason: `${lastError.category}: ${lastError.message}`
        })
      }

      const provider = this.resolve(target.providerId)
      if (!provider) {
        lastError = new NormalizedAIError({
          provider: target.providerId,
          category: 'INVALID_REQUEST',
          message: `Provider "${target.providerId}" is not configured.`,
          classification: 'permanent',
          retryable: false
        })
        continue
      }

      const req = this.mergeRequest(request, target)
      const attemptResult = yield* this.streamOneTarget(provider, req, policy, target, opts)
      if (attemptResult.ok) {
        emit?.({ type: 'final', target, success: true })
        return
      }
      lastError = attemptResult.error
      if (lastError.category === 'CANCELLED') {
        yield { type: 'error', error: lastError }
        return
      }
      if (i === targets.length - 1) {
        emit?.({ type: 'final', target, success: false })
        yield { type: 'error', error: lastError }
      }
    }
  }

  /**
   * Stream from a single target with pre-first-token retry. Returns whether it
   * succeeded; on failure the error is returned (not yielded) so the caller can
   * decide about fallback.
   */
  private async *streamOneTarget(
    provider: AIProvider,
    req: AIRequest,
    policy: RoutingPolicy,
    target: RoutingTarget,
    opts: GatewayCallOptions
  ): AsyncGenerator<AIStreamEvent, { ok: true } | { ok: false; error: NormalizedAIError }> {
    const emit = opts.onEvent
    const maxAttempts = policy.retry.enabled ? policy.retry.maxAttempts : 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        return {
          ok: false,
          error: new NormalizedAIError({
            provider: provider.id,
            category: 'CANCELLED',
            message: 'Request cancelled',
            classification: 'permanent',
            retryable: false
          })
        }
      }
      emit?.({ type: 'attempt_start', target, attempt })
      const acc = new StreamAccumulator(provider.id, req.model)
      let produced = false
      try {
        const iterable = provider.streamMessage(req, this.callOptions(policy, opts))
        for await (const ev of iterable) {
          if (ev.type === 'text_delta' || ev.type === 'reasoning_delta' || ev.type === 'tool_call') {
            produced = true
          }
          if (ev.type === 'error') {
            throw ev.error
          }
          acc.push(ev)
          yield ev
        }
        // Synthesize a completed event if the adapter didn't emit one.
        yield { type: 'completed', response: acc.finalize() }
        return { ok: true }
      } catch (err) {
        const error =
          err instanceof NormalizedAIError ? err : normalizeUnknownError(provider.id, err)

        // If we already streamed content, we cannot safely retry/fallback.
        if (produced) {
          emit?.({ type: 'attempt_error', target, attempt, error, willRetry: false })
          yield { type: 'error', error }
          return { ok: true } // consumed on this target; don't fall back mid-stream
        }

        const canRetry =
          attempt < maxAttempts && policy.retry.enabled && this.retryableStream(error, policy)
        emit?.({ type: 'attempt_error', target, attempt, error, willRetry: canRetry })
        if (!canRetry) {
          return { ok: false, error }
        }
        const delayMs = this.streamDelay(error, policy, attempt, opts)
        emit?.({ type: 'retry_wait', target, attempt, delayMs })
        const sleepFn = opts.retryHooks?.sleep ?? this.sleep.bind(this)
        await sleepFn(delayMs, opts.signal)
      }
    }
    return {
      ok: false,
      error: new NormalizedAIError({
        provider: provider.id,
        category: 'UNKNOWN',
        message: 'Stream retries exhausted',
        classification: 'unknown',
        retryable: false
      })
    }
  }

  private retryableStream(error: NormalizedAIError, policy: RoutingPolicy): boolean {
    if (error.classification === 'permanent' || error.category === 'CANCELLED') return false
    if (error.classification === 'unknown') return policy.retry.unknownErrorBehavior === 'retry'
    return true
  }

  private streamDelay(
    error: NormalizedAIError,
    policy: RoutingPolicy,
    attempt: number,
    opts: GatewayCallOptions
  ): number {
    const rand = opts.retryHooks?.rand ?? Math.random
    if (policy.retry.respectRetryAfter && typeof error.retryAfterMs === 'number') {
      return Math.min(error.retryAfterMs, policy.retry.maxDelayMs)
    }
    const exp =
      policy.retry.initialDelayMs * Math.pow(policy.retry.backoffMultiplier, Math.max(0, attempt - 1))
    const capped = Math.min(exp, policy.retry.maxDelayMs)
    return policy.retry.jitter === 'none' ? capped : Math.round(rand() * capped)
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }
}
