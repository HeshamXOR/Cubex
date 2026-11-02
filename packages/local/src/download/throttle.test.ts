import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressThrottle } from './throttle'

interface Ev {
  n: number
  done: boolean
}

describe('createProgressThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('emits the first event at once and coalesces a burst to the latest value', () => {
    const out: number[] = []
    const t = createProgressThrottle<Ev>((v) => out.push(v.n), { minIntervalMs: 250 })
    for (let i = 1; i <= 100; i++) {
      t.push({ n: i, done: false })
      vi.advanceTimersByTime(1)
    }
    expect(out).toEqual([1])
    vi.advanceTimersByTime(300)
    expect(out).toEqual([1, 100])
  })

  it('delivers a done event immediately, drops stale pending progress, and ignores later events', () => {
    const out: Ev[] = []
    const t = createProgressThrottle<Ev>((v) => out.push(v), { minIntervalMs: 250 })
    t.push({ n: 1, done: false })
    t.push({ n: 2, done: false }) // pending
    t.push({ n: 3, done: true })
    t.push({ n: 4, done: false })
    vi.advanceTimersByTime(1000)
    expect(out.map((e) => e.n)).toEqual([1, 3])
  })
})
