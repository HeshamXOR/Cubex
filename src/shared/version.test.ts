import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, parseVersion } from './version'

describe('parseVersion', () => {
  it('reads the three numbers, with or without a leading v', () => {
    expect(parseVersion('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, pre: [] })
    expect(parseVersion('v1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, pre: [] })
    expect(parseVersion('V10.20.30')).toEqual({ major: 10, minor: 20, patch: 30, pre: [] })
    expect(parseVersion('  0.1.0\n')).toEqual({ major: 0, minor: 1, patch: 0, pre: [] })
  })

  it.each([
    '', 'latest', '1', '1.2', '1.2.3.4', '1.2.x', 'v', '1.2.3-', '1.2.3-beta..1', '-1.2.3', '1.-2.3', '1.2.3 beta', 'one.two.three',
    '1234567890.0.0', `1.2.3-${'a'.repeat(80)}`
  ])('does not take %j for a version', (text) => {
    expect(parseVersion(text)).toBeUndefined()
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

})

describe('isNewerVersion', () => {

  it('is never true for text that is not a version, so a bad tag offers nothing', () => {
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false)
    expect(isNewerVersion('9.9.9', 'unknown')).toBe(false)
    expect(isNewerVersion('', '')).toBe(false)
  })
})
