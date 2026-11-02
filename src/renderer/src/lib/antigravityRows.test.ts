import { describe, expect, it } from 'vitest'
import { IDLE_SIGN_IN, type AntigravityInstallState, type AntigravitySignInState, type AntigravityStatus } from '../../../shared/antigravity'
import { antigravityView } from './antigravityRows'

const idle: AntigravityInstallState = { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: 124_509_787, version: '1.3.0', installedVersion: null, canRemove: false, message: null }

function status(over: { runtime?: Partial<AntigravityInstallState>; signIn?: Partial<AntigravitySignInState> } & Partial<Omit<AntigravityStatus, 'runtime' | 'signIn'>> = {}): AntigravityStatus {
  const { runtime, signIn, ...rest } = over
  return {
    supported: true,
    desktopApp: true,
    runtime: { ...idle, ...runtime },
    signedIn: false,
    signIn: { ...IDLE_SIGN_IN, ...signIn },
    downloadBytes: 124_509_787,
    diskBytes: 226_986_288,
    termsUrl: 'https://antigravity.google/terms',
    localOnly: false,
    ...rest
  }
}

const installed = { installedVersion: '1.3.0', canRemove: true, phase: 'succeeded' as const }

describe('before the runtime is installed', () => {
  it('says why Cubex needs its own runtime, what it costs, and offers to install it', () => {
    const view = antigravityView(status())
    expect(view).toMatchObject({ state: 'signed-out', account: 'Runtime not installed', where: 'Found in the Antigravity desktop app', canAdd: false, working: false })
    expect(view.primary).toEqual({ action: 'install', label: 'Install the runtime' })
    expect(view.intro[0]).toBe('The Antigravity desktop app is installed, but Cubex cannot drive it. Cubex uses Google\'s separate agent runtime instead and signs in to it with your Google account.')
    expect(view.intro[1]).toBe('The download is 125 MB from Google and takes 227 MB on disk. Cubex checks it against a fixed checksum before it runs it.')
  })

  it('says what went wrong when the install failed, and offers to try again', () => {
    const view = antigravityView(status({ runtime: { phase: 'failed', message: 'The Antigravity download failed its size or SHA-256 check. Nothing was installed.' } }))
    expect(view).toMatchObject({ state: 'problem', account: 'The Antigravity download failed its size or SHA-256 check. Nothing was installed.' })
    expect(view.primary).toEqual({ action: 'install', label: 'Try again' })
    expect(view.secondary).toEqual([])
  })

  it('offers nothing to download in local-only mode, and says how to change that', () => {
    const view = antigravityView(status({ localOnly: true }))
    expect(view).toMatchObject({ state: 'unknown', account: 'Not started' })
    expect(view.primary).toBeUndefined()
    expect(view.intro[0]).toBe('Local-only mode is on, so nothing is downloaded or started. Turn it off under Privacy to set up Antigravity.')
  })
})

describe('once the runtime is installed', () => {
  it('asks the person to sign in, and leaves the version to the badge beside the name', () => {
    const view = antigravityView(status({ runtime: installed }))
    expect(view).toMatchObject({ state: 'signed-out', account: 'Not signed in', canAdd: false })
    expect(view.note).toBeUndefined()
    expect(view.primary).toEqual({ action: 'sign-in', label: 'Sign in with Google' })
    expect(view.secondary).toEqual([{ action: 'remove', label: 'Remove' }])
  })

  it('says why a sign-in failed and offers it again', () => {
    const view = antigravityView(status({ runtime: installed, signIn: { phase: 'failed', message: 'Google requires an eligible Antigravity subscription for this account.' } }))
    expect(view).toMatchObject({ state: 'problem', account: 'Google requires an eligible Antigravity subscription for this account.' })
    expect(view.primary).toEqual({ action: 'sign-in', label: 'Try again' })
  })

  it('can be added once it is signed in, and can sign out or be removed', () => {
    const view = antigravityView(status({ runtime: installed, signedIn: true }))
    expect(view).toMatchObject({ state: 'signed-in', account: 'Signed in with Google', canAdd: true })
    expect(view.primary).toBeUndefined()
    expect(view.secondary).toEqual([{ action: 'sign-out', label: 'Sign out' }, { action: 'remove', label: 'Remove' }])
  })

  it('offers the newer release Cubex carries, when the one on disk is older', () => {
    const view = antigravityView(status({ runtime: { ...installed, installedVersion: '1.2.0', version: '1.3.0' }, signedIn: true }))
    expect(view.note).toBe('Version 1.3.0 is available')
    expect(view.secondary[0]).toEqual({ action: 'install', label: 'Update to 1.3.0' })
  })

  it('offers no update in local-only mode, and says why nothing runs', () => {
    const view = antigravityView(status({ runtime: { ...installed, installedVersion: '1.2.0' }, signedIn: true, localOnly: true }))
    expect(view).toMatchObject({ state: 'unknown', account: 'Not started', canAdd: false, intro: ['Local-only mode is on, so Antigravity is not started. Turn it off under Privacy to use it.'] })
    expect(view.secondary).toEqual([{ action: 'remove', label: 'Remove' }])
  })

})
