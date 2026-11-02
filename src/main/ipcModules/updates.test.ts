import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { UpdateState } from '@shared/updates'

const mocks = vi.hoisted(() => ({
  version: '0.1.0',
  packaged: false,
  settings: { updates: undefined as { auto: boolean; skippedVersion?: string } | undefined, privacy: { localOnly: false } },
  saved: [] as unknown[],
  openExternal: vi.fn(async (_url: string) => undefined)
}))
vi.mock('electron', () => ({
  app: { getVersion: () => mocks.version, get isPackaged() { return mocks.packaged }, quit: vi.fn() },
  shell: { openExternal: (url: string) => mocks.openExternal(url) }
}))
vi.mock('../config', () => ({
  getSettings: () => mocks.settings,
  updateSettings: (patch: unknown) => { mocks.saved.push(patch) }
}))
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../paths', () => ({ dataDir: () => 'C:\\data' }))

import { parseInstallRequest, parseSkippedVersion, register } from './updates'

type Handler = (...args: unknown[]) => unknown
let handlers: Map<string, Handler>
let sent: Array<{ channel: string; payload: unknown }>
let cleanup: () => void

function context(): never {
  return {
    handle: (channel: string, fn: Handler) => { handlers.set(channel, fn) },
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) },
    chat: { runningTurns: 0, processManager: { list: () => [] } }
  } as never
}

beforeEach(() => {
  handlers = new Map()
  sent = []
  mocks.version = '0.1.0'
  mocks.packaged = false
  mocks.settings = { updates: undefined, privacy: { localOnly: false } }
  mocks.saved = []
  mocks.openExternal.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
  vi.stubEnv('CUBEX_UPDATE_FEED', '')
  cleanup = register(context())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the update handlers', () => {
  it('declare only the channels the window can call, and not the one the main process pushes on', () => {
    expect([...handlers.keys()].sort()).toEqual([
      IPC.updatesCancel, IPC.updatesCheck, IPC.updatesDownload, IPC.updatesGet, IPC.updatesInstall, IPC.updatesOpenPage, IPC.updatesSkip
    ].sort())
    expect(handlers.has(IPC.updatesState)).toBe(false)
  })

  it('refuse to check in local-only mode, and say how to allow it', async () => {
    mocks.settings.privacy.localOnly = true
    const state = (await handlers.get(IPC.updatesCheck)!()) as UpdateState
    expect(state.check.error).toMatch(/Local-only mode blocks update checks/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ask GitHub, with nothing that identifies the person', async () => {
    await handlers.get(IPC.updatesCheck)!()
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toBe('https://api.github.com/repos/HeshamXOR/Cubex/releases/latest')
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((name) => name.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version'])
    expect((init as { headers: Record<string, string> }).headers['User-Agent']).toBe('Cubex/0.1.0')
  })

  it('open the list of releases from the main process, never an address from the window', async () => {
    await handlers.get(IPC.updatesOpenPage)!('https://evil.example/')
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/HeshamXOR/Cubex/releases')
  })

  it('refuse a skip that does not name a version, before it can change anything', () => {
    for (const value of [undefined, null, '', 'latest', 5, {}, '../..']) {
      expect(() => handlers.get(IPC.updatesSkip)!(value)).toThrow('That is not a version number.')
    }
    expect(mocks.saved).toEqual([])
  })
})

describe('parseInstallRequest', () => {
  it('asks first unless it is told to go ahead, and only a real true counts', () => {
    expect(parseInstallRequest(undefined)).toEqual({})
    expect(parseInstallRequest(null)).toEqual({})
    expect(parseInstallRequest({})).toEqual({ force: false })
    expect(parseInstallRequest({ force: true })).toEqual({ force: true })
    for (const force of ['true', 1, 'yes', {}, [true]]) expect(parseInstallRequest({ force })).toEqual({ force: false })
  })

  it.each(['force', 1, true, ['force']])('refuses %j', (value) => {
    expect(() => parseInstallRequest(value)).toThrow('Invalid update request.')
  })
})

describe('parseSkippedVersion', () => {
  it('names a version the way the releases do', () => {
    expect(parseSkippedVersion('0.2.0')).toBe('0.2.0')
    expect(parseSkippedVersion('v0.2.0')).toBe('0.2.0')
    expect(parseSkippedVersion('1.0.0-beta.1')).toBe('1.0.0-beta.1')
  })

  it.each([undefined, null, '', ' ', 'latest', '1.2', 7, {}, ['0.2.0'], 'x'.repeat(80)])('refuses %j', (value) => {
    expect(() => parseSkippedVersion(value)).toThrow('That is not a version number.')
  })
})
