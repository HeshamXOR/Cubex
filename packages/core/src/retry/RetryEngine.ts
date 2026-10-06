import { NormalizedAIError } from '../types/errors'
import type { RetryPolicy } from '../types/retry'
import { computeBackoff } from './backoff'

export interface RetryHooks {
  /** Called before waiting `delayMs` before the next attempt. */
  onRetry?: (info: { attempt: number; error: NormalizedAIError; delayMs: number }) => void
  /** Called on a terminal (non-retryable / exhausted) error. */
  onGiveUp?: (info: { attempt: number; error: NormalizedAIError }) => void
  /** A further veto after the policy has said an error may be retried (the gateway caps retries of long waits with it). */
  allowRetry?: (error: NormalizedAIError) => boolean
  /** Injectable sleep (tests pass a no-op / fake timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injectable RNG for jitter. */
  rand?: () => number
  signal?: AbortSignal
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Decide whether a normalized error is retryable under a policy. This encodes
 * the transient/permanent/unknown rules plus per-condition toggles.
 */
export function isRetryable(error: NormalizedAIError, policy: RetryPolicy): boolean {
  if (!policy.enabled) return false

  // Permanent errors are never retried — invalid key, bad request, model missing…
  if (error.classification === 'permanent') return false
  if (error.category === 'CANCELLED') return false

  if (error.classification === 'unknown') {
    return policy.unknownErrorBehavior === 'retry'
  }

  // Transient: honor per-condition switches.
  switch (error.category) {
    case 'TIMEOUT':
      return policy.retryOnTimeout
    case 'NETWORK_ERROR':
      return policy.retryOnConnectionError
    case 'RATE_LIMIT_ERROR':
      return policy.retryOn429
    case 'SERVER_ERROR': {
      if (policy.retryOn5xx === 'all') return true
      const code = error.statusCode ?? 500
      return policy.retryOn5xx.includes(code)
    }
    case 'STREAM_ERROR':
      return true
    default:
      // 408 arrives as TIMEOUT category; guard explicit 408 too.
      if (error.statusCode === 408) return policy.retryOn408
      return error.retryable
  }
}

/** The delay to use before the next retry, honoring Retry-After when present. */
export function nextDelay(
  error: NormalizedAIError,
  policy: RetryPolicy,
  retryIndex: number,
  rand: () => number = Math.random
): number {
  if (policy.respectRetryAfter && typeof error.retryAfterMs === 'number') {
    // Never wait longer than maxDelay, but always respect a server ask up to it.
    return Math.min(error.retryAfterMs, policy.maxDelayMs)
  }
  return computeBackoff(policy, retryIndex, rand)
}

/**
 * Execute `fn` with retries. `fn` receives the 1-indexed attempt number and must
 * throw a `NormalizedAIError` on failure (callers wrap provider errors first).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {}
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep
  const rand = hooks.rand ?? Math.random
  const maxAttempts = Math.max(1, policy.enabled ? policy.maxAttempts : 1)

  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1
    if (hooks.signal?.aborted) {
      throw new NormalizedAIError({
        provider: 'gateway',
        category: 'CANCELLED',
        message: 'Request cancelled',
        classification: 'permanent',
        retryable: false
      })
    }
    try {
      return await fn(attempt)
    } catch (err) {
      const error =
        err instanceof NormalizedAIError
          ? err
          : new NormalizedAIError({
              provider: 'gateway',
              category: 'UNKNOWN',
              message: err instanceof Error ? err.message : String(err),
              classification: 'unknown',
              retryable: false,
              cause: err
            })

      const canRetry = attempt < maxAttempts && isRetryable(error, policy) && (hooks.allowRetry?.(error) ?? true)
      if (!canRetry) {
        hooks.onGiveUp?.({ attempt, error })
        throw error
      }

      const delayMs = nextDelay(error, policy, attempt, rand)
      hooks.onRetry?.({ attempt, error, delayMs })
      await sleep(delayMs, hooks.signal)
    }
  }
}
