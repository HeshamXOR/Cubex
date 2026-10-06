import { describe, expect, it } from 'vitest'
import { basename, compactTokens, formatSeconds, plural, shortTime, splitPath } from './format'

describe('paths', () => {
  it('takes the last segment with either separator', () => {
    expect(basename('src/upload/client.ts')).toBe('client.ts')
    expect(basename('C:\\work\\lumen-web\\')).toBe('lumen-web')
    expect(basename('')).toBe('')
  })

  it('splits a folder from its file name', () => {
    expect(splitPath('src/upload/client.ts')).toEqual({ dir: 'src/upload/', name: 'client.ts' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
    expect(splitPath('a\\b\\c.txt')).toEqual({ dir: 'a/b/', name: 'c.txt' })
  })
})

describe('plural', () => {
  it('uses the singular only for one', () => {
    expect(plural(1, 'file')).toBe('1 file')
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(3, 'match', 'matches')).toBe('3 matches')
  })
})

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

  it('never goes negative for a clock that is a little ahead', () => {
    expect(shortTime(now + 5_000, now)).toBe('now')
  })
})

describe('compactTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(950)).toBe('950')
    expect(compactTokens(1200)).toBe('1.2k')
    expect(compactTokens(38_000)).toBe('38k')
    expect(compactTokens(1_500_000)).toBe('1.5M')
  })
})

describe('formatSeconds', () => {
  it('keeps one decimal under ten seconds', () => {
    expect(formatSeconds(800)).toBe('0.8s')
    expect(formatSeconds(6_000)).toBe('6s')
    expect(formatSeconds(72_000)).toBe('1m 12s')
  })
})
