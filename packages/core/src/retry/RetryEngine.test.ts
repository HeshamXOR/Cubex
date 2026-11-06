import { describe, expect, it, vi } from 'vitest'
import { attemptsFor, isRetryable, nextDelay, withRetry } from './RetryEngine'
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

describe('a busy server', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }
  const busy = (statusCode: number) => new NormalizedAIError({ provider: 'p', category: 'SERVER_ERROR', statusCode, message: 'The service is temporarily busy.', classification: 'transient', retryable: true })
  const broken = new NormalizedAIError({ provider: 'p', category: 'SERVER_ERROR', statusCode: 500, message: 'boom', classification: 'transient', retryable: true })

  it('gets more attempts than an ordinary failure', () => {
    expect(attemptsFor(busy(503), policy)).toBe(6)
    expect(attemptsFor(broken, policy)).toBe(3)
  })

  it('does not wait out a spent quota, which will not come back', () => {
    const spent = new NormalizedAIError({ provider: 'p', category: 'RATE_LIMIT_ERROR', statusCode: 429, message: 'You exceeded your current quota.', classification: 'transient', retryable: true })
    expect(attemptsFor(spent, policy)).toBe(3)
  })

  it('still gets no retries when the setting says none', () => {
    expect(attemptsFor(busy(503), { ...policy, maxAttempts: 1 })).toBe(1)
    expect(attemptsFor(busy(503), { ...policy, enabled: false })).toBe(1)
  })

  it('retries 529 even with settings saved before it was on the list', () => {
    expect(isRetryable(busy(529), { ...policy, retryOn5xx: [500, 502, 503, 504] })).toBe(true)
  })

  it('waits longer each time, and never next to nothing', () => {
    expect(nextDelay(busy(503), policy, 1, () => 0)).toBe(1_000)
    expect(nextDelay(busy(503), policy, 3, () => 1)).toBe(8_000)
    expect(nextDelay(busy(503), policy, 7, () => 1)).toBe(30_000)
  })
})

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
})

describe('nextDelay', () => {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 'none', initialDelayMs: 100, maxDelayMs: 5000 }

  it('uses Retry-After when present and respected', () => {
    const e = err({ retryAfterMs: 2000 })
    expect(nextDelay(e, policy, 1)).toBe(2000)
  })
})

describe('withRetry', () => {

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
})
