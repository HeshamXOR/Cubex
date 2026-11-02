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
})
