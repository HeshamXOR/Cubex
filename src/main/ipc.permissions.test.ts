import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { PermissionRule } from '@shared/ipc'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  rules: [] as unknown[],
  resolvePermission: vi.fn((_id: string, _decision: string) => undefined),
  listPermissionRules: vi.fn((_workspace?: string): unknown[] => []),
  removePermissionRule: vi.fn((_id: string) => undefined)
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
vi.mock('./db', () => ({ conversationRepo: { get: () => null }, presetRepo: {}, providerRepo: {}, usageRepo: {} }))
vi.mock('./credentials', () => ({ deleteSecret: vi.fn(), setSecret: vi.fn() }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {} }), updateSettings: vi.fn() }))
vi.mock('./logger', () => ({ recentLogs: () => [] }))
vi.mock('./ProviderManager', () => ({ ProviderManager: class {} }))
vi.mock('./LocalService', () => ({ LocalService: class {} }))
vi.mock('./exporter', () => ({ exportConversation: vi.fn(), importConversation: vi.fn() }))
vi.mock('./skills', () => ({ loadSkills: () => [], readSkill: () => '' }))
vi.mock('./ChatService', () => ({
  ChatService: class {
    resolvePermission = mocks.resolvePermission
    listPermissionRules = mocks.listPermissionRules
    removePermissionRule = mocks.removePermissionRule
    cancelAll(): void {}
    dispose(): void {}
  }
}))

import { registerIpc } from './ipc'

let ipc: ReturnType<typeof registerIpc>

/** Invoke a registered handler the way ipcMain.handle would: a synchronous throw becomes a rejection. */
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => mocks.handlers.get(channel)!({}, ...args)

beforeEach(() => {
  mocks.handlers.clear()
  mocks.resolvePermission.mockClear()
  mocks.listPermissionRules.mockReset().mockReturnValue([])
  mocks.removePermissionRule.mockClear()
  ipc = registerIpc(() => null)
})
afterEach(() => ipc.dispose())

const notStrings = [undefined, null, 42, true, {}, [], ['x']]
const blank = ['', '   ', '\n']

describe('permission IPC', () => {

  it('passes each of the three decisions through to the pending ask', async () => {
    for (const decision of ['allow', 'deny', 'always']) {
      await call(IPC.resolvePermission, 'ask_1', decision)
      expect(mocks.resolvePermission).toHaveBeenLastCalledWith('ask_1', decision)
    }
    expect(mocks.resolvePermission).toHaveBeenCalledTimes(3)
  })

  it('rejects any other decision before it can reach the pending ask', async () => {
    for (const decision of [...notStrings, ...blank, 'ALLOW', 'yes', 'allow ', 'always,allow', 'remember']) {
      await expect(call(IPC.resolvePermission, 'ask_1', decision)).rejects.toThrow('Invalid permission decision.')
    }
    expect(mocks.resolvePermission).not.toHaveBeenCalled()
  })

  it('lists every saved rule, or only those of one workspace', async () => {
    const rule: PermissionRule = { id: 'rule_1', workspace: 'C:\\proj', tool: 'run_command', pattern: 'npm test', label: 'npm test', createdAt: 1 }
    mocks.listPermissionRules.mockReturnValue([rule])
    await expect(call(IPC.listPermissionRules)).resolves.toEqual([rule])
    expect(mocks.listPermissionRules).toHaveBeenLastCalledWith(undefined)
    await call(IPC.listPermissionRules, null)
    expect(mocks.listPermissionRules).toHaveBeenLastCalledWith(undefined)
    await call(IPC.listPermissionRules, 'C:\\proj')
    expect(mocks.listPermissionRules).toHaveBeenLastCalledWith('C:\\proj')
  })
})
