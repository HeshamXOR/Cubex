import { NormalizedAIError } from '../types/errors'
import type { AIProvider } from '../types/provider'
import type { AIRequest, RequestOptions } from '../types/request'
import type { AIResponse } from '../types/response'
import { isOutputEvent, type AIStreamEvent } from '../types/stream'
import { resolveTimeouts, type ResolvedTimeouts } from '../types/timeout'
import type {
  GatewayEventHandler,
  RoutingPolicy,
  RoutingTarget
} from '../types/routing'
import { defaultSleep, isRetryable, nextDelay, withRetry, type RetryHooks } from '../retry/RetryEngine'
import { normalizeUnknownError } from '../errors/normalize'
import { StreamAccumulator } from '../streaming/accumulator'
import { RequestWatchdog, isOverallTimeout, isWaitTimeout, timeoutError } from '../util/timeout'

/** Resolves a providerId to a live AIProvider instance. */
export type ProviderResolver = (providerId: string) => AIProvider | undefined

export interface GatewayCallOptions extends RequestOptions {
  onEvent?: GatewayEventHandler
  /** Test seams. */
  retryHooks?: Partial<RetryHooks>
}

/** The limits one gateway call runs under, and the overall deadline that every attempt of that call shares. */
interface CallLimits {
  limits: ResolvedTimeouts
  deadline?: number
}

/**
 * The single entry point the application uses. It:
 *  - resolves the primary target (and fallbacks, only if explicitly enabled)
 *  - wraps each provider call in the RetryEngine
 *  - emits lifecycle events (attempt / retry / fallback / final) for the UI
 *  - owns every clock: the wait for a response to begin, the silence limit while it streams, and the optional
 *    overall limit (see RequestWatchdog). A request that is still sending is cut by nothing but the overall limit
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

  /** The three limits for one call, from the policy and any per-call override, and when its overall limit runs out. */
  private limitsFor(policy: RoutingPolicy, opts: GatewayCallOptions): CallLimits {
    const limits = resolveTimeouts({ ...policy.timeout, ...opts.timeout })
    return { limits, ...(limits.overallMs > 0 ? { deadline: Date.now() + limits.overallMs } : {}) }
  }

  /** The overall limit's error once its deadline has passed, so a retry or a fallback never starts a request with no time left. */
  private pastDeadline(call: CallLimits, target: RoutingTarget): NormalizedAIError | undefined {
    if (call.deadline === undefined || call.deadline > Date.now()) return undefined
    return timeoutError({ kind: 'overall', ms: call.limits.overallMs }, target.providerId, this.resolve(target.providerId)?.name)
  }

  private newWatchdog(call: CallLimits, opts: GatewayCallOptions): RequestWatchdog {
    return new RequestWatchdog({
      limits: call.limits,
      ...(call.deadline !== undefined ? { deadline: call.deadline } : {}),
      ...(opts.signal ? { signal: opts.signal } : {})
    })
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
    const call = this.limitsFor(policy, opts)
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
        const req = this.mergeRequest(request, target)
        // A wait that already took minutes is retried once, whatever the retry policy allows.
        let waits = 0
        const response = await withRetry(
          async (attempt) => {
            emit?.({ type: 'attempt_start', target, attempt })
            const expired = this.pastDeadline(call, target)
            if (expired) throw expired
            const watchdog = this.newWatchdog(call, opts)
            let providerName = target.providerId
            try {
              // Resolve each attempt so changed routing permissions also apply
              // to retries of a previously cached provider.
              const provider = this.requireProvider(target)
              providerName = provider.name || providerName
              const result = await provider.sendMessage(req, this.callOptions(opts, call, watchdog))
              // An adapter whose stream ends quietly when aborted returns what it had: a cut-off answer, not a response.
              if (watchdog.reached && !opts.signal?.aborted) throw timeoutError(watchdog.reached, target.providerId, providerName)
              return result
            } catch (err) {
              const reached = opts.signal?.aborted ? undefined : watchdog.reached
              const error = reached
                ? timeoutError(reached, target.providerId, providerName)
                : err instanceof NormalizedAIError ? err : normalizeUnknownError(target.providerId, err)
              if (isWaitTimeout(error)) waits++
              throw error
            } finally {
              watchdog.dispose()
            }
          },
          policy.retry,
          { ...this.retryHooksFor(target, policy, opts), allowRetry: (error) => !isWaitTimeout(error) || waits <= 1 }
        )
        emit?.({ type: 'final', target, success: true })
        return response
      } catch (err) {
        lastError = err instanceof NormalizedAIError ? err : normalizeUnknownError(target.providerId, err)
        // Do not fall back on permanent errors that a different model won't fix
        // in a way the user didn't ask for — but the user opted into fallback,
        // so we do try the next target for any error except explicit cancel.
        if (lastError.category === 'CANCELLED') break
        // The overall limit is a ceiling on the whole call: a fallback would start with no time left.
        const hasNext = i < targets.length - 1 && !isOverallTimeout(lastError)
        if (!hasNext) {
          emit?.({ type: 'final', target, success: false })
          break
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

  /**
   * What a provider is called with. The gateway enforces every limit itself, with the watchdog's signal; the provider
   * only learns the two limits an SDK client needs to size its own timeout, and tells the watchdog when it hears from
   * the server (keep-alive comments that never become stream events included).
   */
  private callOptions(opts: GatewayCallOptions, call: CallLimits, watchdog: RequestWatchdog): RequestOptions {
    return {
      signal: watchdog.signal,
      timeout: { requestMs: call.limits.firstResponseMs, streamIdleMs: call.limits.silenceMs },
      onActivity: (kind) => watchdog.activity(kind === 'output'),
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
    const call = this.limitsFor(policy, opts)
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

      const req = this.mergeRequest(request, target)
      const attemptResult = yield* this.streamOneTarget(req, policy, target, opts, call)
      if (attemptResult.ok) {
        emit?.({ type: 'final', target, success: true })
        return
      }
      lastError = attemptResult.error
      // The overall limit is a ceiling on the whole call: a fallback would start with no time left.
      if (attemptResult.partial || lastError.category === 'CANCELLED' || isOverallTimeout(lastError)) {
        emit?.({ type: 'final', target, success: false })
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
    req: AIRequest,
    policy: RoutingPolicy,
    target: RoutingTarget,
    opts: GatewayCallOptions,
    call: CallLimits
  ): AsyncGenerator<AIStreamEvent, { ok: true } | { ok: false; error: NormalizedAIError; partial?: true }> {
    const emit = opts.onEvent
    const maxAttempts = policy.retry.enabled ? policy.retry.maxAttempts : 1
    // A wait that already took minutes is retried once, whatever the retry policy allows.
    let waits = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        return {
          ok: false,
          error: new NormalizedAIError({
            provider: target.providerId,
            category: 'CANCELLED',
            message: 'Request cancelled',
            classification: 'permanent',
            retryable: false
          })
        }
      }
      emit?.({ type: 'attempt_start', target, attempt })
      const expired = this.pastDeadline(call, target)
      if (expired) {
        emit?.({ type: 'attempt_error', target, attempt, error: expired, willRetry: false })
        return { ok: false, error: expired }
      }
      const acc = new StreamAccumulator(target.providerId, req.model)
      let produced = false
      let completed = false
      // The clocks for this attempt. Its signal aborts the provider's own request, not just the iterator.
      const watchdog = this.newWatchdog(call, opts)
      let providerName = target.providerId
      try {
        // Resolver policy failures are normal attempt failures: surface them
        // through error events and only try another explicitly enabled target.
        const provider = this.requireProvider(target)
        providerName = provider.name || providerName
        const iterable = provider.streamMessage(req, this.callOptions(opts, call, watchdog))
        for await (const ev of iterable) {
          // Until the next read the consumer holds this event; its time is not the provider's silence.
          watchdog.pause()
          const output = isOutputEvent(ev)
          watchdog.activity(output)
          if (ev.type === 'completed') {
            // The adapter's final response is authoritative. It may contain
            // text, tool calls, and usage that never appeared as stream deltas.
            // End the adapter iterator here instead of replacing its response
            // with a second, partially accumulated completion.
            completed = true
            yield ev
            return { ok: true }
          }
          // Tool argument deltas are visible activity too. Retrying after a
          // partial plan/call would append the next attempt to stale deltas.
          if (output) produced = true
          if (ev.type === 'error') {
            throw ev.error
          }
          acc.push(ev)
          yield ev
          watchdog.resume()
        }
        // An adapter whose stream ends quietly when aborted must not pass for a finished answer.
        if (watchdog.reached && !opts.signal?.aborted) throw timeoutError(watchdog.reached, target.providerId, providerName)
        // Synthesize a completed event if the adapter didn't emit one.
        yield { type: 'completed', response: acc.finalize() }
        return { ok: true }
      } catch (err) {
        // Iterator cleanup can throw while closing after a terminal completion.
        // A response already delivered to the caller cannot be retracted or retried.
        if (completed) return { ok: true }
        const reached = opts.signal?.aborted ? undefined : watchdog.reached
        const error = opts.signal?.aborted
          ? new NormalizedAIError({ provider: target.providerId, category: 'CANCELLED', message: 'Request cancelled', classification: 'permanent', retryable: false })
          : reached ? timeoutError(reached, target.providerId, providerName)
            : err instanceof NormalizedAIError ? err : normalizeUnknownError(target.providerId, err)
        if (isWaitTimeout(error)) waits++

        // If we already streamed content, we cannot safely retry/fallback.
        if (produced) {
          emit?.({ type: 'attempt_error', target, attempt, error, willRetry: false })
          // The outer loop reports failure without replaying a partially shown
          // response or treating the terminal error as a successful completion.
          return { ok: false, error, partial: true }
        }

        const canRetry =
          attempt < maxAttempts && policy.retry.enabled && this.retryableStream(error, policy) && (!isWaitTimeout(error) || waits <= 1)
        emit?.({ type: 'attempt_error', target, attempt, error, willRetry: canRetry })
        if (!canRetry) {
          return { ok: false, error }
        }
        const delayMs = this.streamDelay(error, policy, attempt, opts)
        emit?.({ type: 'retry_wait', target, attempt, delayMs })
        const sleepFn = opts.retryHooks?.sleep ?? defaultSleep
        try {
          await sleepFn(delayMs, opts.signal)
        } catch {
          // Stop pressed during back-off: a cancellation, never a raw AbortError.
          return { ok: false, error: new NormalizedAIError({ provider: target.providerId, category: 'CANCELLED', message: 'Request cancelled', classification: 'permanent', retryable: false }) }
        }
      } finally {
        watchdog.dispose()
      }
    }
    return {
      ok: false,
      error: new NormalizedAIError({
        provider: target.providerId,
        category: 'UNKNOWN',
        message: 'Stream retries exhausted',
        classification: 'unknown',
        retryable: false
      })
    }
  }

  /** Same per-condition rules (retryOn429, retryOn5xx, …) as non-streaming send(). */
  private retryableStream(error: NormalizedAIError, policy: RoutingPolicy): boolean {
    return isRetryable(error, policy.retry)
  }

  private streamDelay(
    error: NormalizedAIError,
    policy: RoutingPolicy,
    attempt: number,
    opts: GatewayCallOptions
  ): number {
    return nextDelay(error, policy.retry, attempt, opts.retryHooks?.rand ?? Math.random)
  }
}
