import type { JitterStrategy, RetryPolicy } from '../types/retry'

/**
 * Compute the delay before attempt N (1-indexed retries: attempt 1 is the first
 * *retry*). Exponential backoff with configurable jitter, capped at maxDelayMs.
 *
 * `rand` is injectable so tests are deterministic.
 */
export function computeBackoff(
  policy: RetryPolicy,
  retryIndex: number,
  rand: () => number = Math.random
): number {
  const exp = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, Math.max(0, retryIndex - 1))
  const capped = Math.min(exp, policy.maxDelayMs)
  return applyJitter(capped, policy.jitter, rand)
}

export function applyJitter(base: number, strategy: JitterStrategy, rand: () => number): number {
  switch (strategy) {
    case 'none':
      return base
    case 'full':
      // random in [0, base]
      return Math.round(rand() * base)
    case 'equal':
      // base/2 + random in [0, base/2]
      return Math.round(base / 2 + rand() * (base / 2))
    default:
      return base
  }
}
