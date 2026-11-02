import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../../shared/updates'
import { canInstallUpdate, dismissalKey, installBlocker, nextStep, progressPercent, type Update } from './updateText'

const info = (extra: Partial<Update['info']> = {}): Update['info'] => ({
  version: '0.2.0',
  name: 'Cubex 0.2.0',
  notes: '- A thing',
  pageUrl: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
  installer: { name: 'Cubex-Setup-0.2.0.exe', size: 89_484_330 },
  ...extra
})
const update = (extra: Partial<Update> = {}, details: Partial<Update['info']> = {}): Update => ({ info: info(details), stage: 'available', ...extra })
const state = (extra: Partial<UpdateState> = {}): UpdateState => ({ currentVersion: '0.1.0', canInstall: true, check: { status: 'idle' }, ...extra })

describe('progress', () => {

  it('is a whole percentage that never leaves 0 to 100', () => {
    expect(progressPercent(undefined)).toBeUndefined()
    expect(progressPercent({ received: 5, total: 0 })).toBeUndefined()
    expect(progressPercent({ received: 0, total: 200 })).toBe(0)
    expect(progressPercent({ received: 99, total: 200 })).toBe(49)
    expect(progressPercent({ received: 200, total: 200 })).toBe(100)
    expect(progressPercent({ received: 900, total: 200 })).toBe(100)
    expect(progressPercent({ received: -4, total: 200 })).toBe(0)
  })
})

describe('whether Cubex can install the update itself', () => {
  it('can for a copy the installer set up and a release with a verified installer', () => {
    expect(canInstallUpdate(state(), update())).toBe(true)
    expect(installBlocker(state(), update())).toBeUndefined()
  })

  it('cannot for a copy that is not set up that way, and says why', () => {
    const portable = state({ canInstall: false, cannotInstallReason: 'This copy was not set up with the Cubex installer, so it cannot update itself.' })
    expect(canInstallUpdate(portable, update())).toBe(false)
    expect(installBlocker(portable, update())).toBe('This copy was not set up with the Cubex installer, so it cannot update itself.')
    expect(installBlocker(state({ canInstall: false }), update())).toMatch(/cannot update itself/)
  })

  it('cannot for a release without an installer it can verify, and says why', () => {
    const bare = update({}, { installer: undefined, installerProblem: 'This release has no checksum, so Cubex will not install it for you. Download it from the release page.' })
    expect(canInstallUpdate(state(), bare)).toBe(false)
    expect(installBlocker(state(), bare)).toMatch(/no checksum/)
    expect(installBlocker(state(), update({}, { installer: undefined }))).toMatch(/no installer Cubex can use/)
  })
})

describe('nextStep', () => {
  it('is to download first, then to restart', () => {
    expect(nextStep(state(), update())).toEqual({ kind: 'download', label: 'Download update' })
    expect(nextStep(state(), update({ stage: 'ready' }))).toEqual({ kind: 'restart', label: 'Restart to update' })
  })

  it('is to try again when the last attempt failed', () => {
    expect(nextStep(state(), update({ error: 'The download stopped.' }))).toEqual({ kind: 'download', label: 'Try again' })
    expect(nextStep(state(), update({ stage: 'ready', error: 'Cubex could not start the installer.' }))).toEqual({ kind: 'restart', label: 'Try again' })
  })

  it('is the release page for a copy or a release that Cubex cannot install', () => {
    expect(nextStep(state({ canInstall: false }), update())).toEqual({ kind: 'release', label: 'View release' })
    expect(nextStep(state(), update({}, { installer: undefined }))).toEqual({ kind: 'release', label: 'View release' })
    expect(nextStep(state({ canInstall: false }), update({ error: 'x' }))).toEqual({ kind: 'release', label: 'View release' })
  })

})

describe('what "Later" puts off', () => {
  it('is one stage of one version, and an error to read counts as news', () => {
    expect(dismissalKey(update())).toBe('0.2.0:available')
    expect(dismissalKey(update({ stage: 'ready' }))).toBe('0.2.0:ready')
    expect(dismissalKey(update({ error: 'The download stopped.' }))).toBe('0.2.0:available:error')
    expect(dismissalKey(update({}, { version: '0.3.0' }))).toBe('0.3.0:available')
  })
})
