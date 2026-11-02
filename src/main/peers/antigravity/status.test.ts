import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDLE_SIGN_IN, type AntigravityInstallState } from '@shared/antigravity'
import { resolveAntigravityReleaseAsset } from './release'
import { antigravityStatus } from './status'

const IDLE: AntigravityInstallState = { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, canRemove: false, message: null }

let profile = ''
beforeEach(() => { profile = mkdtempSync(join(tmpdir(), 'cubex-agy-status-')) })
afterEach(() => { rmSync(profile, { recursive: true, force: true }) })

describe('what is told about Antigravity', () => {
  it('says what a supported computer would download and what it would take on disk', () => {
    const asset = resolveAntigravityReleaseAsset('win32', 'x64')!
    const status = antigravityStatus({ asset, runtime: IDLE, signIn: IDLE_SIGN_IN, profileDirectory: profile, desktopApp: true, localOnly: false })
    expect(status).toMatchObject({ supported: true, desktopApp: true, downloadBytes: 124_509_787, diskBytes: 81_437_336 + 145_548_952, localOnly: false })
    expect(status.termsUrl).toBe('https://antigravity.google/terms')
  })

  it('says so when Google publishes no runtime for the computer', () => {
    const status = antigravityStatus({ asset: null, runtime: IDLE, signIn: IDLE_SIGN_IN, profileDirectory: profile, desktopApp: false, localOnly: false })
    expect(status).toMatchObject({ supported: false, downloadBytes: null, diskBytes: null })
  })

  it('is signed in only when the runtime has saved its sign-in, without reading it', () => {
    const asset = resolveAntigravityReleaseAsset('win32', 'x64')
    const ask = (): boolean => antigravityStatus({ asset, runtime: IDLE, signIn: IDLE_SIGN_IN, profileDirectory: profile, desktopApp: false, localOnly: false }).signedIn
    expect(ask()).toBe(false)
    mkdirSync(join(profile, 'antigravity-acp'), { recursive: true })
    expect(ask()).toBe(false)
    writeFileSync(join(profile, 'antigravity-acp', 'acp_token.json'), 'not a token, and never read')
    expect(ask()).toBe(true)
  })

  it('passes the install and the sign-in on as they are', () => {
    const runtime: AntigravityInstallState = { ...IDLE, operationId: 'o1', phase: 'downloading', downloadedBytes: 5, totalBytes: 10, message: 'Downloading.' }
    const signIn = { ...IDLE_SIGN_IN, phase: 'waiting' as const, flowId: 'f1' }
    const status = antigravityStatus({ asset: null, runtime, signIn, profileDirectory: profile, desktopApp: false, localOnly: true })
    expect(status.runtime).toBe(runtime)
    expect(status.signIn).toBe(signIn)
    expect(status.localOnly).toBe(true)
  })
})
