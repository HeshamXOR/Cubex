import { describe, expect, it } from 'vitest'
import { formatBytes, formatSeconds, shortTime } from './format'

describe('shortTime', () => {
  const now = new Date('2026-10-02T12:00:00Z').getTime()
  it('uses the compact age scale', () => {
    expect(shortTime(now - 20_000, now)).toBe('now')
    expect(shortTime(now - 2 * 60_000, now)).toBe('2m')
    expect(shortTime(now - 59 * 60_000, now)).toBe('59m')
    expect(shortTime(now - 2 * 3_600_000, now)).toBe('2h')
    expect(shortTime(now - 23 * 3_600_000, now)).toBe('23h')
  })

  it('names the weekday within a week and the date after that', () => {
    expect(shortTime(now - 3 * 86_400_000, now)).toMatch(/^[A-Za-z]{3,4}\.?$/)
    expect(shortTime(now - 20 * 86_400_000, now)).toMatch(/\d/)
  })

})

describe('formatSeconds', () => {
  it('counts in whole seconds, minutes and hours', () => {
    expect(formatSeconds(800)).toBe('0s')
    expect(formatSeconds(6_900)).toBe('6s')
    expect(formatSeconds(59_999)).toBe('59s')
    expect(formatSeconds(72_000)).toBe('1m 12s')
    expect(formatSeconds(3_600_000)).toBe('1h 0m')
    expect(formatSeconds(7_512_000)).toBe('2h 5m')
  })
})

describe('formatBytes', () => {
  it('writes a size in the unit a person reads', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(89_484_330)).toBe('85 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })

})
