/**
 * Retry configuration. The engine classifies errors (transient/permanent/unknown)
 * and only retries transient ones (plus unknown, per `unknownErrorBehavior`).
 */

export type JitterStrategy = 'none' | 'full' | 'equal'

export interface RetryPolicy {
  enabled: boolean
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  jitter: JitterStrategy
  retryOnTimeout: boolean
  retryOnConnectionError: boolean
  retryOn408: boolean
  retryOn429: boolean
  /** Which 5xx codes to retry, or 'all'. */
  retryOn5xx: number[] | 'all'
  /** Honor a provider-supplied Retry-After header/field. */
  respectRetryAfter: boolean
  /** What to do with UNKNOWN-classified errors. */
  unknownErrorBehavior: 'retry' | 'fail'
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitter: 'full',
  retryOnTimeout: true,
  retryOnConnectionError: true,
  retryOn408: true,
  retryOn429: true,
  retryOn5xx: [500, 502, 503, 504],
  respectRetryAfter: true,
  unknownErrorBehavior: 'fail'
}
