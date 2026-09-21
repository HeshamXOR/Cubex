import { describe, expect, it, vi } from 'vitest'
import { isRetryable, nextDelay, withRetry } from './RetryEngine'
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../types/retry'
import { NormalizedAIError } from '../types/errors'

function err(overrides: Partial<ConstructorParameters<typeof NormalizedAIError>[0]>): NormalizedAIError {
  return new NormalizedAIError({
    provider: 'test',
    category: 'SERVER_ERROR',
    message: 'boom',
    classification: 'transient',
    retryable: true,
    ...overrides
  })
}

const noSleep = () => Promise.resolve()

describe('isRetryable', () => {
  const policy = DEFAULT_RETRY_POLICY

  it('never retries permanent errors', () => {
    expect(isRetryable(err({ category: 'AUTHENTICATION_ERROR', classification: 'permanent', retryable: false }), policy)).toBe(false)
    expect(isRetryable(err({ category: 'INVALID_REQUEST', classification: 'permanent', retryable: false }), policy)).toBe(false)
    expect(isRetryable(err({ category: 'MODEL_NOT_FOUND', classification: 'permanent', retryable: false }), policy)).toBe(false)
  })

  it('retries transient errors (429/5xx/timeout/network)', () => {
    expect(isRetryable(err({ category: 'RATE_LIMIT_ERROR', statusCode: 429 }), policy)).toBe(true)
    expect(isRetryable(err({ category: 'SERVER_ERROR', statusCode: 503 }), policy)).toBe(true)
    expect(isRetryable(err({ category: 'TIMEOUT' }), policy)).toBe(true)
    expect(isRetryable(err({ category: 'NETWORK_ERROR' }), policy)).toBe(true)
  })

  it('does not retry a 5xx code excluded from the policy list', () => {
    const p: RetryPolicy = { ...policy, retryOn5xx: [503] }
    expect(isRetryable(err({ category: 'SERVER_ERROR', statusCode: 500 }), p)).toBe(false)
    expect(isRetryable(err({ category: 'SERVER_ERROR', statusCode: 503 }), p)).toBe(true)
  })

  it('honors per-condition toggles', () => {
    expect(isRetryable(err({ category: 'RATE_LIMIT_ERROR' }), { ...policy, retryOn429: false })).toBe(false)
    expect(isRetryable(err({ category: 'TIMEOUT' }), { ...policy, retryOnTimeout: false })).toBe(false)
  })

  it('unknown errors follow unknownErrorBehavior', () => {
    const unknown = err({ category: 'UNKNOWN', classification: 'unknown', retryable: false })
    expect(isRetryable(unknown, { ...policy, unknownErrorBehavior: 'fail' })).toBe(false)
    expect(isRetryable(unknown, { ...policy, unknownErrorBehavior: 'retry' })).toBe(true)
  })

  it('respects enabled=false', () => {
    expect(isRetryable(err({ category: 'SERVER_ERROR' }), { ...policy, enabled: false })).toBe(false)
  })
})

describe('nextDelay', () => {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 'none', initialDelayMs: 100, maxDelayMs: 5000 }

  it('uses Retry-After when present and respected', () => {
    const e = err({ retryAfterMs: 2000 })
    expect(nextDelay(e, policy, 1)).toBe(2000)
  })

  it('caps Retry-After at maxDelay', () => {
    const e = err({ retryAfterMs: 999_999 })
    expect(nextDelay(e, policy, 1)).toBe(5000)
  })

  it('ignores Retry-After when respectRetryAfter=false', () => {
    const e = err({ retryAfterMs: 2000 })
    expect(nextDelay(e, { ...policy, respectRetryAfter: false }, 1)).toBe(100)
  })
})

describe('withRetry', () => {
  it('succeeds on first try without sleeping', async () => {
    const fn = vi.fn(async () => 'ok')
    const result = await withRetry(fn, DEFAULT_RETRY_POLICY, { sleep: noSleep })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures then succeeds', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n += 1
      if (n < 3) throw err({ category: 'SERVER_ERROR', statusCode: 500 })
      return 'recovered'
    })
    const onRetry = vi.fn()
    const result = await withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, { sleep: noSleep, onRetry, rand: () => 0.5 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('stops immediately on a permanent error', async () => {
    const fn = vi.fn(async () => {
      throw err({ category: 'AUTHENTICATION_ERROR', classification: 'permanent', retryable: false })
    })
    const onGiveUp = vi.fn()
    await expect(withRetry(fn, DEFAULT_RETRY_POLICY, { sleep: noSleep, onGiveUp })).rejects.toMatchObject({
      category: 'AUTHENTICATION_ERROR'
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledOnce()
  })

  it('gives up after maxAttempts', async () => {
    const fn = vi.fn(async () => {
      throw err({ category: 'SERVER_ERROR', statusCode: 500 })
    })
    await expect(withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, { sleep: noSleep })).rejects.toMatchObject({
      category: 'SERVER_ERROR'
    })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('passes the Retry-After delay to onRetry', async () => {
    let n = 0
    const fn = async () => {
      n += 1
      if (n === 1) throw err({ category: 'RATE_LIMIT_ERROR', statusCode: 429, retryAfterMs: 1234 })
      return 'ok'
    }
    const onRetry = vi.fn()
    await withRetry(fn, { ...DEFAULT_RETRY_POLICY, respectRetryAfter: true }, { sleep: noSleep, onRetry })
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 1234 }))
  })
})
