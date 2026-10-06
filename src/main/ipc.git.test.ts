import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type SessionFileChange } from '@shared/ipc'
import { commitCount, committedPaths, git, hasGit, initRepo, porcelain, seedHistory, write, writeHook } from './tools/gitTestHelpers'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  selected: undefined as string | undefined,
  conversations: new Map<string, { id: string; workspacePath?: string }>(),
  changes: [] as Array<Pick<SessionFileChange, 'path' | 'status'>>,
  getSessionChanges: vi.fn(async (_conversationId: string) => mocks.changes)
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
  scratch = mkdtempSync(join(tmpdir(), 'cubex-ipc-git-'))
  mocks.handlers.clear()
  mocks.conversations.clear()
  mocks.selected = undefined
  mocks.changes = []
  mocks.getSessionChanges.mockClear()
  ipc = registerIpc(() => null)
})

afterEach(() => {
  ipc.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

describe('git IPC', () => {
  it('registers its channels and removes them on dispose', () => {
    for (const channel of [IPC.gitCommit, IPC.gitSuggestMessage]) expect(mocks.handlers.has(channel)).toBe(true)
    expect(IPC.gitCommit).toBe('git:commit')
    expect(IPC.gitSuggestMessage).toBe('git:suggest-message')
    ipc.dispose()
    expect(mocks.handlers.size).toBe(0)
  })

  describe('gitSuggestMessage', () => {
    it('builds a subject from the changes of the task', async () => {
      mocks.changes = [{ path: 'src/client.ts', status: 'modified' }, { path: 'src/backoff.ts', status: 'added' }]
      await expect(call(IPC.gitSuggestMessage, 'c1')).resolves.toBe('Update client.ts and add backoff.ts')
      expect(mocks.getSessionChanges).toHaveBeenCalledWith('c1')
      mocks.changes = []
      await expect(call(IPC.gitSuggestMessage, 'c1')).resolves.toBe('')
    })

    it('rejects malformed task ids before reaching the service', async () => {
      for (const bad of [undefined, null, 42, {}, '', '   ', 'x'.repeat(257)]) {
        await expect(call(IPC.gitSuggestMessage, bad)).rejects.toThrow('Invalid task id.')
      }
      expect(mocks.getSessionChanges).not.toHaveBeenCalled()
    })
  })

  describe('gitCommit', () => {
    it('rejects malformed task ids and reports unknown tasks and missing workspaces as results', async () => {
      for (const bad of [undefined, null, 42, '', 'x'.repeat(257)]) {
        await expect(call(IPC.gitCommit, bad, { message: 'x', paths: ['a.txt'] })).rejects.toThrow('Invalid task id.')
      }
      await expect(call(IPC.gitCommit, 'missing', { message: 'x', paths: ['a.txt'] })).resolves.toEqual({ ok: false, error: 'Task was not found.' })
      mocks.conversations.set('c1', { id: 'c1' })
      const noWorkspace = await call(IPC.gitCommit, 'c1', { message: 'x', paths: ['a.txt'] })
      expect(noWorkspace).toMatchObject({ ok: false })
      expect((noWorkspace as { error: string }).error).toMatch(/workspace/i)
    })

    it.each([
      ['no request', undefined], ['a string', 'x'], ['an empty message', { message: '', paths: ['a.txt'] }],
      ['a message over 2000 characters', { message: 'x'.repeat(2001), paths: ['a.txt'] }], ['no paths', { message: 'x', paths: [] }],
      ['paths that are not a list', { message: 'x', paths: 'a.txt' }],
      ['more than 200 paths', { message: 'x', paths: Array.from({ length: 201 }, (_, index) => `f${index}.txt`) }]
    ])('returns an error result for %s without running git', async (_label, request) => {
      mocks.conversations.set('c1', { id: 'c1', workspacePath: scratch })
      const result = await call(IPC.gitCommit, 'c1', request)
      expect(result).toMatchObject({ ok: false })
      expect(typeof (result as { error: string }).error).toBe('string')
    })

    describe.skipIf(!hasGit)('in a repository', { timeout: 30_000 }, () => {
      let repo: string

      beforeEach(() => {
        repo = join(scratch, 'repo')
        initRepo(repo)
        seedHistory(repo)
        mocks.conversations.set('c1', { id: 'c1', workspacePath: repo })
      })

      it('commits exactly the listed files and answers with the contract shape', async () => {
        write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
        write(repo, 'sub/b.txt', 'bee\nbuzz\n')
        write(repo, 'staged.txt', 'staged by the user\n')
        git(repo, 'add', 'staged.txt')
        const result = await call(IPC.gitCommit, 'c1', { message: 'Update a', paths: ['a.txt'] })
        expect(result).toEqual({ ok: true, commit: git(repo, 'rev-parse', '--short', 'HEAD').trim(), summary: expect.stringContaining('Update a') })
        expect(Object.keys(result as object).sort()).toEqual(['commit', 'ok', 'summary'])
        expect((result as { summary: string }).summary).toMatch(/1 file changed, 1 insertion\(\+\)/)
        expect(committedPaths(repo)).toEqual(['a.txt'])
        expect(porcelain(repo)).toEqual([' M sub/b.txt', 'A  staged.txt'])
      })

      it('commits in the workspace of the task, not the selected workspace', async () => {
        const other = join(scratch, 'other')
        initRepo(other)
        seedHistory(other)
        mocks.selected = other
        write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
        const before = commitCount(other)
        await expect(call(IPC.gitCommit, 'c1', { message: 'In the task repository', paths: ['a.txt'] })).resolves.toMatchObject({ ok: true })
        expect(commitCount(other)).toBe(before)
        expect(commitCount(repo)).toBe(3)
      })

      it('returns the output of a hook that rejects the commit', async () => {
        writeHook(repo, 'pre-commit', 'echo "lint: forbidden word" >&2\nexit 1')
        write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
        const result = await call(IPC.gitCommit, 'c1', { message: 'Rejected', paths: ['a.txt'] })
        expect(result).toMatchObject({ ok: false })
        expect((result as { error: string }).error).toContain('lint: forbidden word')
        expect(commitCount(repo)).toBe(2)
      })

      it('refuses paths outside the workspace and reports nothing to commit', async () => {
        write(scratch, 'outside.txt', 'outside')
        const escaped = await call(IPC.gitCommit, 'c1', { message: 'x', paths: ['../outside.txt'] })
        expect(escaped).toMatchObject({ ok: false })
        expect((escaped as { error: string }).error).toMatch(/outside the workspace/)
        const nothing = await call(IPC.gitCommit, 'c1', { message: 'x', paths: ['a.txt'] })
        expect((nothing as { error: string }).error).toMatch(/nothing to commit/i)
        expect(commitCount(repo)).toBe(2)
      })
    })
  })
})
