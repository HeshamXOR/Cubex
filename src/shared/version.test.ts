import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, normalizeVersion, parseVersion } from './version'

describe('parseVersion', () => {
  it('reads the three numbers, with or without a leading v', () => {
    expect(parseVersion('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, pre: [] })
    expect(parseVersion('v1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, pre: [] })
    expect(parseVersion('V10.20.30')).toEqual({ major: 10, minor: 20, patch: 30, pre: [] })
    expect(parseVersion('  0.1.0\n')).toEqual({ major: 0, minor: 1, patch: 0, pre: [] })
  })

  it('reads a prerelease, numbers as numbers, and ignores build metadata', () => {
    expect(parseVersion('1.5.0-beta.2')?.pre).toEqual(['beta', 2])
    expect(parseVersion('1.5.0-rc.1+build.7')).toEqual({ major: 1, minor: 5, patch: 0, pre: ['rc', 1] })
    expect(parseVersion('1.5.0+20260101')?.pre).toEqual([])
  })

  it.each([
    '', 'latest', '1', '1.2', '1.2.3.4', '1.2.x', 'v', '1.2.3-', '1.2.3-beta..1', '-1.2.3', '1.-2.3', '1.2.3 beta', 'one.two.three',
    '1234567890.0.0', `1.2.3-${'a'.repeat(80)}`
  ])('does not take %j for a version', (text) => {
    expect(parseVersion(text)).toBeUndefined()
  })

  it('never throws on something that is not text', () => {
    for (const value of [undefined, null, 4, {}, [], true, Symbol('x')]) expect(parseVersion(value)).toBeUndefined()
  })
})

describe('normalizeVersion', () => {
  it('drops the v and the build metadata and nothing else', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0')
    expect(normalizeVersion('0.2.0-beta.1+sha.5114f85')).toBe('0.2.0-beta.1')
    expect(normalizeVersion('2.0.0')).toBe('2.0.0')
  })

  it('answers undefined for text that is not a version', () => {
    expect(normalizeVersion('nightly')).toBeUndefined()
    expect(normalizeVersion(undefined)).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.2.0', -1],
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.1.0', 0],
    ['v0.1.0', '0.1.0', 0],
    ['1.0.0', '0.9.9', 1],
    ['0.9.10', '0.9.9', 1],
    ['0.10.0', '0.9.0', 1],
    ['2.0.0', '10.0.0', -1],
    // Prereleases sit below their final release and order as semver says.
    ['0.2.0-beta.1', '0.2.0', -1],
    ['0.2.0', '0.2.0-beta.1', 1],
    ['0.2.0-alpha', '0.2.0-beta', -1],
    ['0.2.0-beta.2', '0.2.0-beta.10', -1],
    ['0.2.0-beta.2', '0.2.0-beta.2', 0],
    ['0.2.0-alpha', '0.2.0-alpha.1', -1],
    ['0.2.0-1', '0.2.0-alpha', -1],
    ['0.2.0-rc.1', '0.1.9', 1],
    ['0.2.0-rc.1+one', '0.2.0-rc.1+two', 0]
  ] as const)('compares %s with %s as %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('has no answer when either side is not a version', () => {
    expect(compareVersions('latest', '0.1.0')).toBeUndefined()
    expect(compareVersions('0.1.0', '')).toBeUndefined()
  })
})

describe('isNewerVersion', () => {
  it('is true only for a strictly higher version', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.2.0', '0.2.0-beta.1')).toBe(true)
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false)
  })

  it('is never true for text that is not a version, so a bad tag offers nothing', () => {
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false)
    expect(isNewerVersion('9.9.9', 'unknown')).toBe(false)
    expect(isNewerVersion('', '')).toBe(false)
  })
})
