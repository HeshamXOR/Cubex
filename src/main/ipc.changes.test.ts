import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  selected: undefined as string | undefined,
  conversations: new Map<string, { id: string; workspacePath?: string }>(),
  getSessionChanges: vi.fn(async (_conversationId: string) => []),
  revertSessionChanges: vi.fn(async (_conversationId: string, _paths?: string[]) => ({ restored: [], skipped: [] }))
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
  conversationRepo: { get: (id: string) => mocks.conversations.get(id) ?? null },
  presetRepo: {}, providerRepo: {}, usageRepo: {}
}))
vi.mock('./credentials', () => ({ deleteSecret: vi.fn(), setSecret: vi.fn() }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.selected } }), updateSettings: vi.fn() }))
vi.mock('./logger', () => ({ recentLogs: () => [] }))
vi.mock('./ProviderManager', () => ({ ProviderManager: class {} }))
vi.mock('./LocalService', () => ({ LocalService: class {} }))
vi.mock('./exporter', () => ({ exportConversation: vi.fn(), importConversation: vi.fn() }))
vi.mock('./skills', () => ({ loadSkills: () => [], readSkill: () => '' }))
vi.mock('./ChatService', () => ({
  ChatService: class {
    getSessionChanges = mocks.getSessionChanges
    revertSessionChanges = mocks.revertSessionChanges
    cancelAll(): void {}
    dispose(): void {}
  }
}))

import { registerIpc } from './ipc'

let ipc: ReturnType<typeof registerIpc>
let scratch: string

/** Invoke a registered handler the way ipcMain.handle would: a synchronous throw becomes a rejection. */
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => mocks.handlers.get(channel)!({}, ...args)

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cubex-ipc-changes-'))
  mocks.handlers.clear()
  mocks.conversations.clear()
  mocks.selected = undefined
  mocks.getSessionChanges.mockClear()
  mocks.revertSessionChanges.mockClear()
  ipc = registerIpc(() => null)
})

afterEach(() => {
  ipc.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

describe('session changes and git status IPC', () => {
  it('registers its channels and removes them on dispose', () => {
    for (const channel of [IPC.getSessionChanges, IPC.revertSessionChanges, IPC.getGitStatus]) {
      expect(mocks.handlers.has(channel)).toBe(true)
    }
    ipc.dispose()
    expect(mocks.handlers.size).toBe(0)
  })

  it('lists changes for a valid task id and rejects malformed ids before reaching the service', async () => {
    await expect(call(IPC.getSessionChanges, 'c1')).resolves.toEqual([])
    expect(mocks.getSessionChanges).toHaveBeenCalledWith('c1')
    for (const bad of [undefined, null, 42, {}, '', '   ', 'x'.repeat(257)]) {
      await expect(call(IPC.getSessionChanges, bad)).rejects.toThrow('Invalid task id.')
    }
    expect(mocks.getSessionChanges).toHaveBeenCalledTimes(1)
  })

  it('validates revert input, and no path list means every file', async () => {
    await call(IPC.revertSessionChanges, 'c1')
    await call(IPC.revertSessionChanges, 'c1', ['src/a.ts', 'b.txt'])
    await call(IPC.revertSessionChanges, 'c1', [])
    expect(mocks.revertSessionChanges.mock.calls).toEqual([['c1', undefined], ['c1', ['src/a.ts', 'b.txt']], ['c1', []]])

    const tooMany = Array.from({ length: 2_001 }, (_, index) => `file-${index}.txt`)
    for (const bad of ['a.txt', [42], [''], ['bad\0path'], ['x'.repeat(4_097)], tooMany, { 0: 'a.txt' }]) {
      await expect(call(IPC.revertSessionChanges, 'c1', bad)).rejects.toThrow('list of workspace-relative')
    }
    await expect(call(IPC.revertSessionChanges, '', ['a.txt'])).rejects.toThrow('Invalid task id.')
    await expect(call(IPC.revertSessionChanges, 7)).rejects.toThrow('Invalid task id.')
    expect(mocks.revertSessionChanges).toHaveBeenCalledTimes(3)
  })

  it('resolves the git workspace the way the other workspace calls do', async () => {
    expect(await call(IPC.getGitStatus)).toBeNull()

    mocks.selected = join(scratch, 'missing')
    expect(await call(IPC.getGitStatus)).toEqual({ isRepo: false, changedFiles: 0 })

    // A task answers for its own folder: it never borrows the globally selected one.
    mocks.conversations.set('bare', { id: 'bare' })
    expect(await call(IPC.getGitStatus, 'bare')).toBeNull()
    mocks.conversations.set('gone', { id: 'gone', workspacePath: join(scratch, 'also-missing') })
    expect(await call(IPC.getGitStatus, 'gone')).toEqual({ isRepo: false, changedFiles: 0 })

    await expect(call(IPC.getGitStatus, 'unknown')).rejects.toThrow('Task was not found.')
    for (const bad of ['', '  ', 7, null, 'x'.repeat(257)]) {
      await expect(call(IPC.getGitStatus, bad)).rejects.toThrow('Invalid task id.')
    }
  })
})
