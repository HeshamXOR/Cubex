import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXTERNAL_EDIT_REASON, SESSION_BASELINE_MAX_BYTES, SessionChangeStore, summarizeTextDiff, validateRevertPaths } from './sessionChanges'

let root: string
let workspace: string
let storage: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-session-changes-'))
  workspace = join(root, 'project')
  storage = join(root, 'storage')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Change a file the way a file tool does, then report the mutation like onMutate. */
function toolWrite(store: SessionChangeStore, rel: string, content: string | Buffer): void {
  const path = join(workspace, rel)
  const existed = existsSync(path)
  const before = existed ? readFileSync(path) : Buffer.alloc(0)
  const after = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, after)
  store.record('task', path, before, existed, after)
}

function toolRemove(store: SessionChangeStore, rel: string): void {
  const path = join(workspace, rel)
  const before = readFileSync(path)
  unlinkSync(path)
  store.record('task', path, before, true, null)
}

const read = (rel: string): string => readFileSync(join(workspace, rel), 'utf8')

describe('SessionChangeStore', () => {
  it('reports created, modified and deleted files against their pre-task state', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree')
    writeFileSync(join(workspace, 'gone.txt'), 'bye')
    toolWrite(store, 'a.txt', 'one\nTWO\nthree')
    toolWrite(store, 'src/new.ts', 'export {}\nconst x = 1')
    toolRemove(store, 'gone.txt')

    const changes = await store.list('task', workspace)
    expect(changes.map(({ path, status, added, removed }) => ({ path, status, added, removed }))).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'src/new.ts', status: 'added', added: 2, removed: 0 }
    ])
    expect(changes[0]!.diff).toBe(' one\n-two\n+TWO\n three')
    expect(changes.every((change) => change.externallyModified === undefined && change.updatedAt > 0)).toBe(true)
  })

  it('omits files that are back to their original state', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'original')
    toolWrite(store, 'a.txt', 'changed')
    toolWrite(store, 'a.txt', 'original')
    toolWrite(store, 'temp.txt', 'scratch')
    toolRemove(store, 'temp.txt')
    expect(await store.list('task', workspace)).toEqual([])
    // Nothing tracked means nothing stored for the task.
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([])
  })

  it('reverts one file and keeps tracking the others', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'a0')
    writeFileSync(join(workspace, 'b.txt'), 'b0')
    toolWrite(store, 'a.txt', 'a1')
    toolWrite(store, 'b.txt', 'b1')

    const { result, files } = await store.revert('task', workspace, ['a.txt'])
    expect(result).toEqual({ restored: ['a.txt'], skipped: [], revertId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
    expect(files).toEqual([join(workspace, 'a.txt')])
    expect(read('a.txt')).toBe('a0')
    expect(read('b.txt')).toBe('b1')
    expect((await store.list('task', workspace)).map((change) => change.path)).toEqual(['b.txt'])
  })

  it('reverts everything: restores originals, deletes created files and recreates removed ones', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'original a')
    writeFileSync(join(workspace, 'gone.txt'), 'original gone')
    toolWrite(store, 'a.txt', 'edited a')
    toolWrite(store, 'a.txt', 'edited a twice')
    toolWrite(store, 'nested/new.txt', 'created')
    toolRemove(store, 'gone.txt')

    const { result } = await store.revert('task', workspace)
    expect(result.restored.sort()).toEqual(['a.txt', 'gone.txt', 'nested/new.txt'])
    expect(result.skipped).toEqual([])
    expect(read('a.txt')).toBe('original a')
    expect(read('gone.txt')).toBe('original gone')
    expect(existsSync(join(workspace, 'nested', 'new.txt'))).toBe(false)
    expect(await store.list('task', workspace)).toEqual([])
  })

  it('skips files changed outside Cubex and preserves those edits', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'original')
    writeFileSync(join(workspace, 'b.txt'), 'original b')
    toolWrite(store, 'a.txt', 'cubex edit')
    toolRemove(store, 'b.txt')
    writeFileSync(join(workspace, 'a.txt'), 'user edit')
    writeFileSync(join(workspace, 'b.txt'), 'user recreated it')

    const changes = await store.list('task', workspace)
    expect(changes.map((change) => [change.path, change.externallyModified])).toEqual([['a.txt', true], ['b.txt', true]])
    const { result } = await store.revert('task', workspace)
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'a.txt', reason: EXTERNAL_EDIT_REASON },
      { path: 'b.txt', reason: EXTERNAL_EDIT_REASON }
    ])
    expect(read('a.txt')).toBe('user edit')
    expect(read('b.txt')).toBe('user recreated it')
    expect(await store.list('task', workspace)).toHaveLength(2)
  })

  it('keeps baselines across store instances', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'before restart')
    toolWrite(new SessionChangeStore(storage), 'a.txt', 'after restart')

    const reopened = new SessionChangeStore(storage)
    const changes = await reopened.list('task', workspace)
    expect(changes).toMatchObject([{ path: 'a.txt', status: 'modified', added: 1, removed: 1 }])
    expect((await reopened.revert('task', workspace)).result.restored).toEqual(['a.txt'])
    expect(read('a.txt')).toBe('before restart')
    expect(await new SessionChangeStore(storage).list('task', workspace)).toEqual([])
  })

  it('reports files over the size cap without keeping a restore point', async () => {
    const store = new SessionChangeStore(storage)
    const big = Buffer.alloc(SESSION_BASELINE_MAX_BYTES + 1, 'a')
    writeFileSync(join(workspace, 'big.txt'), big)
    toolWrite(store, 'big.txt', 'small now')

    expect(await store.list('task', workspace)).toMatchObject([{ path: 'big.txt', status: 'modified', added: 0, removed: 0, diff: '' }])
    const { result } = await store.revert('task', workspace)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toMatch(/too large/i)
    expect(read('big.txt')).toBe('small now')
    // Only the index was written; the large original was never copied.
    const [task] = readdirSync(storage)
    expect(readdirSync(join(storage, task!, 'blobs'))).toEqual([])
  })

  it('stops keeping originals once the per-task budget is used', async () => {
    const store = new SessionChangeStore(storage, { maxTaskBytes: 10 })
    writeFileSync(join(workspace, 'a.txt'), 'aaaaaaaa')
    writeFileSync(join(workspace, 'b.txt'), 'bbbbbbbb')
    toolWrite(store, 'a.txt', 'a1')
    toolWrite(store, 'b.txt', 'b1')

    const { result } = await store.revert('task', workspace)
    expect(result.restored).toEqual(['a.txt'])
    expect(result.skipped).toEqual([{ path: 'b.txt', reason: expect.stringMatching(/storage limit/) }])
    expect(read('a.txt')).toBe('aaaaaaaa')
    expect(read('b.txt')).toBe('b1')
  })

  it('treats binary files as non-diffable but restores their exact bytes', async () => {
    const store = new SessionChangeStore(storage)
    const original = Buffer.from([0, 1, 2, 255, 0, 10])
    writeFileSync(join(workspace, 'image.bin'), original)
    toolWrite(store, 'image.bin', Buffer.from([0, 9, 9]))

    expect(await store.list('task', workspace)).toMatchObject([{ path: 'image.bin', status: 'modified', added: 0, removed: 0, diff: '' }])
    expect((await store.revert('task', workspace)).result.restored).toEqual(['image.bin'])
    expect(readFileSync(join(workspace, 'image.bin')).equals(original)).toBe(true)
  })

  it('rejects paths outside the workspace before restoring anything', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'original')
    toolWrite(store, 'a.txt', 'changed')

    await expect(store.revert('task', workspace, ['a.txt', '../outside.txt'])).rejects.toThrow('escapes the workspace')
    await expect(store.revert('task', workspace, [join(root, 'outside.txt')])).rejects.toThrow('relative to the workspace')
    await expect(store.revert('task', workspace, ['C:outside.txt'])).rejects.toThrow('relative to the workspace')
    expect(read('a.txt')).toBe('changed')
    expect(() => validateRevertPaths('a.txt')).toThrow('list of workspace-relative')
    expect(() => validateRevertPaths([42])).toThrow('list of workspace-relative')
    expect(() => validateRevertPaths(['bad\0path'])).toThrow('list of workspace-relative')
    expect(validateRevertPaths(undefined)).toBeUndefined()
    expect((await store.revert('task', workspace, ['untouched.txt'])).result.skipped).toEqual([
      { path: 'untouched.txt', reason: 'Cubex has not changed this file in this task.' }
    ])
  })

  it('refuses to restore through a folder swapped for a junction', async () => {
    const store = new SessionChangeStore(storage)
    const outside = join(root, 'outside')
    mkdirSync(outside)
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'a.txt'), 'original')
    toolWrite(store, 'sub/a.txt', 'cubex edit')
    writeFileSync(join(outside, 'a.txt'), 'cubex edit')
    renameSync(join(workspace, 'sub'), join(workspace, 'sub-old'))
    symlinkSync(outside, join(workspace, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const { result } = await store.revert('task', workspace)
      expect(result.restored).toEqual([])
      expect(result.skipped).toEqual([{ path: 'sub/a.txt', reason: expect.stringMatching(/folder was moved/) }])
      expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('cubex edit')
    } finally { unlinkSync(join(workspace, 'sub')) }
  })

  it('treats a rewind as a Cubex write and a rewind to the original as no change', async () => {
    const store = new SessionChangeStore(storage)
    const path = join(workspace, 'a.txt')
    writeFileSync(path, 'v0')
    toolWrite(store, 'a.txt', 'v1')
    toolWrite(store, 'a.txt', 'v2')

    // A rewind of the second turn restores v1: still a change, but not an external one.
    writeFileSync(path, 'v1')
    await store.syncRestored('task', [path])
    expect(await store.list('task', workspace)).toMatchObject([{ path: 'a.txt', status: 'modified' }])
    expect((await store.list('task', workspace))[0]!.externallyModified).toBeUndefined()

    // Rewinding the first turn too returns the file to v0: no net change remains.
    writeFileSync(path, 'v0')
    await store.syncRestored('task', [path])
    expect(await store.list('task', workspace)).toEqual([])
  })

  it('ignores files outside the current workspace and removes a deleted task', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'original')
    toolWrite(store, 'a.txt', 'changed')
    expect(await store.list('task', join(root, 'another-project'))).toEqual([])
    expect(await store.list('task', undefined)).toEqual([])
    expect(await store.list('other-task', workspace)).toEqual([])

    store.deleteConversation('task')
    expect(readdirSync(storage)).toEqual([])
    expect(await new SessionChangeStore(storage).list('task', workspace)).toEqual([])
    expect(() => store.deleteConversation('')).toThrow('valid task id')
  })
})

describe('summarizeTextDiff', () => {
  it('keeps a small edit in a large file fast and condensed', () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
    const edited = [...lines]
    edited[10_000] = 'changed'
    const started = Date.now()
    const summary = summarizeTextDiff(lines.join('\n'), edited.join('\n'))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(summary).toMatchObject({ added: 1, removed: 1 })
    expect(summary.diff.split('\n')).toEqual([
      '@⋯ 9997 unchanged lines', ' line 9997', ' line 9998', ' line 9999', '-line 10000', '+changed',
      ' line 10001', ' line 10002', ' line 10003', '@⋯ 9996 unchanged lines'
    ])
  })

  it('counts a removed empty line', () => {
    expect(summarizeTextDiff('x\n\ny', 'x\ny')).toEqual({ added: 0, removed: 1, diff: ' x\n-\n y' })
  })
})
