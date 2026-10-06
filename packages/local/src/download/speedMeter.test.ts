import { describe, expect, it } from 'vitest'
import { SpeedMeter } from './speedMeter'

describe('SpeedMeter', () => {
  it('has no speed until it has two samples', () => {
    let now = 0
    const m = new SpeedMeter({ now: () => now })
    expect(m.bytesPerSecond()).toBeUndefined()
    m.add(0)
    expect(m.bytesPerSecond()).toBeUndefined()
  })

  it('computes bytes per second over the window and an ETA from it', () => {
    let now = 0
    const m = new SpeedMeter({ now: () => now })
    for (let i = 0; i <= 3; i++) {
      m.add(i * 10_000_000)
      now += 1000
    }
    // 30 MB over 3 s of samples (t = 0..3000 ms, last sample taken at t = 3000).
    expect(m.bytesPerSecond()).toBeCloseTo(10_000_000, -3)
    expect(m.etaSeconds(70_000_000)).toBeCloseTo(7, 0)
  })

  it('forgets samples older than the window so a slowdown shows up', () => {
    let now = 0
    const m = new SpeedMeter({ windowMs: 2000, now: () => now })
    m.add(0)
    now = 1000
    m.add(100_000_000) // fast burst
    now = 10_000
    m.add(100_000_000)
    now = 11_000
    m.add(100_001_000) // 1 KB in the last second
    expect(m.bytesPerSecond()!).toBeCloseTo(1000, 0)
  })

  it('treats a counter that goes backwards (a new layer or a restart) as a fresh start', () => {
    let now = 0
    const m = new SpeedMeter({ now: () => now })
    m.add(50_000_000)
    now = 1000
    m.add(60_000_000)
    now = 2000
    m.add(1_000) // went backwards
    expect(m.bytesPerSecond()).toBeUndefined()
    now = 3000
    m.add(5_001_000)
    expect(m.bytesPerSecond()).toBeCloseTo(5_000_000, -3)
  })

  it('returns no ETA when speed is zero or nothing remains', () => {
    let now = 0
    const m = new SpeedMeter({ now: () => now })
    m.add(5)
    now = 1000
    m.add(5)
    expect(m.etaSeconds(100)).toBeUndefined()
    now = 2000
    m.add(105)
    expect(m.etaSeconds(0)).toBeUndefined()
  })
})
