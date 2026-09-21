import { describe, expect, it } from 'vitest'
import { computeStats } from './stats'

describe('computeStats', () => {
  it('computes exact stats for a known array', () => {
    const s = computeStats([2, 4, 4, 4, 5, 5, 7, 9])
    expect(s.mean).toBe(5)
    expect(s.median).toBe(4.5)
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.variance).toBe(4) // population variance
    expect(s.stddev).toBe(2)
  })

  it('handles an odd-length array median', () => {
    expect(computeStats([1, 3, 100]).median).toBe(3)
  })

  it('is safe for empty and single-element arrays', () => {
    expect(computeStats([])).toEqual({ mean: 0, median: 0, min: 0, max: 0, variance: 0, stddev: 0 })
    const one = computeStats([42])
    expect(one.mean).toBe(42)
    expect(one.variance).toBe(0)
  })
})
