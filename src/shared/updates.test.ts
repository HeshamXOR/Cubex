import { describe, expect, it } from 'vitest'
import { DEFAULT_UPDATE_SETTINGS, initialUpdateState, normalizeUpdateSettings } from './updates'

describe('normalizeUpdateSettings', () => {
  it('checks automatically and skips nothing until the person says otherwise', () => {
    expect(DEFAULT_UPDATE_SETTINGS).toEqual({ auto: true })
    expect(normalizeUpdateSettings(undefined)).toEqual({ auto: true })
  })

  it.each([null, 'on', 5, true, []])('falls back to the default for %j', (value) => {
    expect(normalizeUpdateSettings(value)).toEqual({ auto: true })
  })

  it('keeps a choice that was made', () => {
    expect(normalizeUpdateSettings({ auto: false })).toEqual({ auto: false })
    expect(normalizeUpdateSettings({ auto: true, skippedVersion: '0.2.0' })).toEqual({ auto: true, skippedVersion: '0.2.0' })
  })

  it.each(['yes', 1, 0, null])('does not read %j as a choice of checking', (auto) => {
    expect(normalizeUpdateSettings({ auto }).auto).toBe(true)
  })

  it('stores the skipped version the way a release names it, without a leading v', () => {
    expect(normalizeUpdateSettings({ skippedVersion: 'v0.2.0' })).toEqual({ auto: true, skippedVersion: '0.2.0' })
    expect(normalizeUpdateSettings({ skippedVersion: 'V1.0.0-beta.2' }).skippedVersion).toBe('1.0.0-beta.2')
  })

  it.each(['', 'latest', '1.2', 42, null, {}, 'x'.repeat(200)])('drops a skipped version that is %j', (skippedVersion) => {
    expect(normalizeUpdateSettings({ auto: false, skippedVersion })).toEqual({ auto: false })
  })

  it('keeps nothing else that was stored in the block', () => {
    expect(normalizeUpdateSettings({ auto: true, url: 'https://example.com/latest', channel: 'nightly' })).toEqual({ auto: true })
  })

  it('returns a new object each time, so a caller cannot change the default', () => {
    const settings = normalizeUpdateSettings(undefined)
    settings.auto = false
    expect(DEFAULT_UPDATE_SETTINGS.auto).toBe(true)
    expect(normalizeUpdateSettings(undefined).auto).toBe(true)
  })
})

describe('initialUpdateState', () => {
  it('has seen nothing and cannot yet say that this copy updates itself', () => {
    expect(initialUpdateState('0.1.0')).toEqual({ currentVersion: '0.1.0', canInstall: false, check: { status: 'idle' } })
  })
})
