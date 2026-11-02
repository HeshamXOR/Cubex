import { describe, expect, it } from 'vitest'
import { SpeedMeter } from './speedMeter'

describe('SpeedMeter', () => {

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
})
