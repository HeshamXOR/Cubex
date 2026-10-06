import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  compactConversation: vi.fn()
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
vi.mock('./db', () => ({ conversationRepo: {}, presetRepo: {}, providerRepo: {}, usageRepo: {} }))
vi.mock('./credentials', () => ({ deleteSecret: vi.fn(), setSecret: vi.fn() }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {} }), updateSettings: vi.fn() }))
vi.mock('./logger', () => ({ recentLogs: () => [] }))
vi.mock('./ProviderManager', () => ({ ProviderManager: class {} }))
vi.mock('./LocalService', () => ({ LocalService: class {} }))
vi.mock('./exporter', () => ({ exportConversation: vi.fn(), importConversation: vi.fn() }))
vi.mock('./skills', () => ({ loadSkills: () => [], readSkill: () => '' }))
vi.mock('./ChatService', () => ({
  ChatService: class {
    compactConversation = mocks.compactConversation
    cancelAll(): void {}
    dispose(): void {}
  }
}))

import { registerIpc } from './ipc'

let ipc: ReturnType<typeof registerIpc>

/** Invoke a registered handler the way ipcMain.handle would. */
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => mocks.handlers.get(channel)!({}, ...args)

beforeEach(() => {
  mocks.handlers.clear()
  mocks.compactConversation.mockReset()
  ipc = registerIpc(() => null)
})
afterEach(() => ipc.dispose())

describe('compactConversation IPC', () => {
  it('registers its channel and removes it on dispose', () => {
    expect(IPC.compactConversation).toBe('conv:compact')
    expect(mocks.handlers.has(IPC.compactConversation)).toBe(true)
    ipc.dispose()
    expect(mocks.handlers.size).toBe(0)
  })

  it('passes a valid task id to the service and returns its result unchanged', async () => {
    const ok = { ok: true, summary: 'Goal: ship.', boundaryMessageId: 'm4' }
    mocks.compactConversation.mockResolvedValueOnce(ok)
    await expect(call(IPC.compactConversation, 'c1')).resolves.toEqual(ok)
    expect(mocks.compactConversation).toHaveBeenCalledWith('c1')

    const refused = { ok: false, error: 'Stop the running turn before compacting this task.' }
    mocks.compactConversation.mockResolvedValueOnce(refused)
    await expect(call(IPC.compactConversation, 'c1')).resolves.toEqual(refused)
  })

  it.each([undefined, null, 42, {}, [], '', '   ', 'x'.repeat(257)])('rejects malformed task id case %# with an error result, before reaching the service', async (bad) => {
    await expect(call(IPC.compactConversation, bad)).resolves.toEqual({ ok: false, error: 'Invalid task id.' })
    expect(mocks.compactConversation).not.toHaveBeenCalled()
  })

  it('turns an unexpected failure into an error result instead of rejecting', async () => {
    mocks.compactConversation.mockRejectedValueOnce(new Error('disk full'))
    await expect(call(IPC.compactConversation, 'c1')).resolves.toEqual({ ok: false, error: 'disk full' })
    mocks.compactConversation.mockRejectedValueOnce('plain string failure')
    await expect(call(IPC.compactConversation, 'c1')).resolves.toEqual({ ok: false, error: 'plain string failure' })
  })
})
