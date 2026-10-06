import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { ProviderConfig } from '@core/types'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  stored: new Map<string, unknown>(),
  setSecret: vi.fn((ref: string, _secret: string): { ok: boolean; ref: string; message?: string } => ({ ok: true, ref })),
  deleteSecret: vi.fn((_ref: string) => undefined),
  invalidate: vi.fn((_id: string) => undefined),
  test: vi.fn(async (_id: string) => ({ ok: true })),
  listModels: vi.fn(async (_id: string) => [])
}))

vi.mock('electron', () => ({
  app: { getPath: () => process.env.CUBEX_DATA_DIR ?? process.cwd() },
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (channel: string, listener: Listener) => { mocks.handlers.set(channel, listener) },
    removeHandler: (channel: string) => { mocks.handlers.delete(channel) }
  }
}))
vi.mock('./db', () => ({
  conversationRepo: { get: () => null },
  presetRepo: {},
  usageRepo: {},
  providerRepo: {
    list: () => [...mocks.stored.values()],
    get: (id: string) => mocks.stored.get(id),
    save: (cfg: { id: string }) => { mocks.stored.set(cfg.id, cfg) },
    delete: (id: string) => { mocks.stored.delete(id) }
  }
}))
vi.mock('./credentials', () => ({ deleteSecret: mocks.deleteSecret, setSecret: mocks.setSecret }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {} }), updateSettings: vi.fn() }))
vi.mock('./logger', () => ({ recentLogs: () => [] }))
vi.mock('./ProviderManager', () => ({
  ProviderManager: class {
    invalidate = mocks.invalidate
    test = mocks.test
    listModels = mocks.listModels
  }
}))
vi.mock('./LocalService', () => ({ LocalService: class {} }))
vi.mock('./exporter', () => ({ exportConversation: vi.fn(), importConversation: vi.fn() }))
vi.mock('./skills', () => ({ loadSkills: () => [], readSkill: () => '' }))
vi.mock('./ChatService', () => ({ ChatService: class { cancelAll(): void {} dispose(): void {} } }))

import { registerIpc } from './ipc'

let ipc: ReturnType<typeof registerIpc>
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => mocks.handlers.get(channel)!({}, ...args)

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p1', kind: 'openai', name: 'OpenAI', accessType: 'api', baseUrl: 'https://api.openai.com/v1', auth: { type: 'api_key', scheme: 'bearer' }, enabled: true, ...overrides
})

beforeEach(() => {
  mocks.handlers.clear()
  mocks.stored.clear()
  mocks.setSecret.mockClear().mockImplementation((ref) => ({ ok: true, ref }))
  mocks.deleteSecret.mockClear()
  mocks.invalidate.mockClear()
  mocks.test.mockClear()
  mocks.listModels.mockClear()
  ipc = registerIpc(() => null)
})
afterEach(() => ipc.dispose())

describe('provider IPC', () => {
  it('saves a valid provider and refreshes the cached adapter', async () => {
    const saved = await call(IPC.saveProvider, provider()) as ProviderConfig
    expect(saved).toMatchObject({ id: 'p1', name: 'OpenAI' })
    expect(mocks.stored.get('p1')).toEqual(saved)
    expect(mocks.invalidate).toHaveBeenCalledWith('p1')
    expect(mocks.setSecret).not.toHaveBeenCalled()
  })

  it('stores a pasted key under a reference of its own and saves only the reference', async () => {
    const saved = await call(IPC.saveProvider, provider(), '  sk-secret\n') as ProviderConfig
    expect(saved.credentialRef).toMatch(/^cred_p1_[A-Za-z0-9_-]{6}$/)
    expect(mocks.setSecret).toHaveBeenCalledWith(saved.credentialRef, 'sk-secret')
    expect(JSON.stringify(mocks.stored.get('p1'))).not.toContain('sk-secret')
  })

  it('keeps the reference a provider already has when its key is replaced', async () => {
    await call(IPC.saveProvider, provider({ credentialRef: 'cred_p1_abcdef' }))
    const saved = await call(IPC.saveProvider, provider({ credentialRef: 'cred_p1_abcdef' }), 'sk-new') as ProviderConfig
    expect(saved.credentialRef).toBe('cred_p1_abcdef')
    expect(mocks.setSecret).toHaveBeenCalledWith('cred_p1_abcdef', 'sk-new')
  })

  it('refuses to point a provider at the key of another one', async () => {
    await call(IPC.saveProvider, provider({ id: 'p1', credentialRef: 'cred_p1_abcdef' }))
    await expect(call(IPC.saveProvider, provider({ id: 'p2', name: 'Other', credentialRef: 'cred_p1_abcdef' }), 'sk-evil'))
      .rejects.toThrow('That stored key belongs to another provider.')
    expect(mocks.setSecret).not.toHaveBeenCalled()
    expect(mocks.stored.has('p2')).toBe(false)
  })

  it('saves nothing when the key cannot be stored securely', async () => {
    mocks.setSecret.mockReturnValue({ ok: false, ref: 'x', message: 'OS credential encryption is unavailable.' })
    await expect(call(IPC.saveProvider, provider(), 'sk-secret')).rejects.toThrow('OS credential encryption is unavailable.')
    expect(mocks.stored.size).toBe(0)
  })

  it('rejects a malformed provider before anything is stored', async () => {
    for (const input of [null, 'openai', provider({ baseUrl: 'ftp://example.com' }), { ...provider(), kind: 'skynet' }, { ...provider(), id: '../x' }, { ...provider(), headers: { 'X-A': 'a\r\nb' } }]) {
      await expect(call(IPC.saveProvider, input, 'sk-secret')).rejects.toThrow('The provider settings are not valid.')
    }
    expect(mocks.stored.size).toBe(0)
    expect(mocks.setSecret).not.toHaveBeenCalled()
  })

  it('rejects a key that is not text', async () => {
    await expect(call(IPC.saveProvider, provider(), 42)).rejects.toThrow('The key must be text.')
    expect(mocks.stored.size).toBe(0)
  })

  it('removes the saved key together with the provider', async () => {
    await call(IPC.saveProvider, provider({ credentialRef: 'cred_p1_abcdef' }))
    await call(IPC.deleteProvider, 'p1')
    expect(mocks.deleteSecret).toHaveBeenCalledWith('cred_p1_abcdef')
    expect(mocks.stored.has('p1')).toBe(false)
    expect(mocks.invalidate).toHaveBeenLastCalledWith('p1')
  })

  it.each([IPC.deleteProvider, IPC.testProvider, IPC.listModels])('checks the provider id sent to %s', async (channel) => {
    for (const id of [undefined, null, '', '../x', 'a b', 5, {}, 'a'.repeat(121)]) {
      await expect(call(channel, id)).rejects.toThrow('Invalid provider id.')
    }
    expect(mocks.deleteSecret).not.toHaveBeenCalled()
    expect(mocks.test).not.toHaveBeenCalled()
    expect(mocks.listModels).not.toHaveBeenCalled()
  })

  it('tests and lists models for a valid id', async () => {
    await call(IPC.testProvider, 'p1')
    await call(IPC.listModels, 'p1')
    expect(mocks.test).toHaveBeenCalledWith('p1')
    expect(mocks.listModels).toHaveBeenCalledWith('p1')
  })
})
