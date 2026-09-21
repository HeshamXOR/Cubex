import { describe, expect, it } from 'vitest'
import { applyJitter, computeBackoff } from './backoff'
import { DEFAULT_RETRY_POLICY } from '../types/retry'

describe('computeBackoff', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, jitter: 'none' as const, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 10_000 }

  it('grows exponentially without jitter', () => {
    expect(computeBackoff(policy, 1)).toBe(100)
    expect(computeBackoff(policy, 2)).toBe(200)
    expect(computeBackoff(policy, 3)).toBe(400)
    expect(computeBackoff(policy, 4)).toBe(800)
  })

  it('caps at maxDelayMs', () => {
    const capped = computeBackoff({ ...policy, maxDelayMs: 500 }, 10)
    expect(capped).toBe(500)
  })

  it('full jitter yields a value within [0, base]', () => {
    const base = 1000
    for (const r of [0, 0.5, 0.999]) {
      const v = applyJitter(base, 'full', () => r)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(base)
    }
    expect(applyJitter(base, 'full', () => 0)).toBe(0)
    expect(applyJitter(base, 'full', () => 1)).toBe(1000)
  })

  it('equal jitter yields a value within [base/2, base]', () => {
    const base = 1000
    expect(applyJitter(base, 'equal', () => 0)).toBe(500)
    expect(applyJitter(base, 'equal', () => 1)).toBe(1000)
  })

  it('none jitter returns base unchanged', () => {
    expect(applyJitter(777, 'none', () => 0.3)).toBe(777)
  })
})
