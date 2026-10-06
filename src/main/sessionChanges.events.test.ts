import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionChangeStore, type SessionChangeStoreOptions } from './sessionChanges'

let root: string
let workspace: string
let storage: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-review-events-'))
  workspace = join(root, 'project')
  storage = join(root, 'storage')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (rel: string): string => readFileSync(join(workspace, rel), 'utf8')
const lines = (count: number, edit: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => edit[i] ?? `line ${i}`).join('\n') + '\n'
const session = { kind: 'session' } as const

/** Change a file the way a file tool does, then report the mutation like onMutate. */
function toolWrite(store: SessionChangeStore, rel: string, content: string): void {
  const path = join(workspace, rel)
  const existed = existsSync(path)
  const before = existed ? readFileSync(path) : Buffer.alloc(0)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  store.record('task', path, before, existed, Buffer.from(content, 'utf8'))
}

function toolRemove(store: SessionChangeStore, rel: string): void {
  const path = join(workspace, rel)
  const before = readFileSync(path)
  unlinkSync(path)
  store.record('task', path, before, true, null)
}

/** f.txt (30 lines) edited in two places 20 lines apart: two hunks. One recorded change. */
function seedTwoHunks(store: SessionChangeStore): void {
  writeFileSync(join(workspace, 'f.txt'), lines(30))
  toolWrite(store, 'f.txt', lines(30, { 5: 'five changed', 25: 'twenty-five changed' }))
}

function twoHunks(options: SessionChangeStoreOptions = {}): SessionChangeStore {
  const store = new SessionChangeStore(storage, options)
  seedTwoHunks(store)
  return store
}

describe('review change events', () => {
  it('reports every change to the review state once it is stored, with a rising revision', async () => {
    const seen: Array<{ revision: number; stored: boolean }> = []
    const store: SessionChangeStore = new SessionChangeStore(storage, {
      // A listener that reads the store sees the change already saved.
      onChange: (_task, revision) => seen.push({ revision, stored: store.revision('task') === revision })
    })
    seedTwoHunks(store)
    expect(seen.map((entry) => entry.revision)).toEqual([1])

    toolWrite(store, 'f.txt', lines(30, { 5: 'five changed', 25: 'twenty-five changed', 12: 'twelve' }))
    const [file] = await store.review('task', workspace, session)
    // Looking at the changes is not a change.
    expect(seen).toHaveLength(2)
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [file!.hunks[0]!.id], headHash: file!.headHash! }])
    await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[1]!.id], expectHeadHash: file!.headHash! })
    const [after] = await store.review('task', workspace, session)
    const reverted = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [after!.hunks[0]!.id], expectHeadHash: after!.headHash! })
    await store.undoRevert('task', workspace, reverted.revertId!)
    expect(seen.map((entry) => entry.revision)).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen.every((entry) => entry.stored)).toBe(true)
  })

  it('reports a whole-file undo and a rewind that put files back', async () => {
    const seen: number[] = []
    const store = twoHunks({ onChange: (_task, revision) => seen.push(revision) })
    const { result } = await store.revert('task', workspace, ['f.txt'])
    toolWrite(store, 'f.txt', lines(30, { 5: 'again' }))
    writeFileSync(join(workspace, 'f.txt'), lines(30))
    await store.syncRestored('task', [join(workspace, 'f.txt')])
    expect(result.restored).toEqual(['f.txt'])
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('does not tell anyone when nothing changed', async () => {
    const seen: number[] = []
    const store = twoHunks({ onChange: (_task, revision) => seen.push(revision) })
    const [file] = await store.review('task', workspace, session)
    const item = { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], headHash: file!.headHash! }
    await store.markReviewed('task', workspace, [item])
    await store.markReviewed('task', workspace, [item])
    await store.markReviewed('task', workspace, [{ ...item, headHash: 'a'.repeat(64) }, { ...item, hunkIds: ['f'.repeat(40)] }])
    await store.revert('task', workspace, ['not-tracked.txt'])
    expect(seen).toEqual([1, 2])
  })

  it('keeps counting when the last change is undone and the task has nothing left to store', () => {
    const store = new SessionChangeStore(storage)
    toolWrite(store, 'g.txt', 'new\n')
    toolRemove(store, 'g.txt')
    // Back at its original state: nothing is tracked, the task's storage is gone, the count is not.
    expect(readdirSync(storage)).toEqual([])
    expect(store.revision('task')).toBe(2)
    toolWrite(store, 'h.txt', 'x\n')
    expect(store.revision('task')).toBe(3)
  })

  it('never lets a failing listener break an edit or a revert', async () => {
    const errors: unknown[] = []
    const store = twoHunks({ onChange: () => { throw new Error('window is gone') }, onError: (error) => errors.push(error) })
    const [file] = await store.review('task', workspace, session)
    await expect(store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })).resolves.toMatchObject({ conflicts: [] })
    expect(read('f.txt')).toBe(lines(30, { 25: 'twenty-five changed' }))
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('accepted hunks in the notes for the model', () => {
  it('counts a hunk once however often it is kept', async () => {
    const store = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const item = { path: 'f.txt', hunkIds: file!.hunks.map((hunk) => hunk.id), headHash: file!.headHash! }
    await store.markReviewed('task', workspace, [item])
    await store.markReviewed('task', workspace, [item])
    expect(store.pendingReviewNotes('task')).toMatch(/Accepted in f\.txt: 2 hunks/)
  })

  it('leaves no review state behind when nothing was accepted', async () => {
    const store = twoHunks()
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: ['f'.repeat(40)], headHash: 'a'.repeat(64) }])
    expect(store.pendingReviewNotes('task')).toBeUndefined()
    const index = JSON.parse(readFileSync(join(storage, readdirSync(storage)[0]!, 'index.json'), 'utf8')) as Record<string, unknown>
    expect(index).not.toHaveProperty('hunkStates')
    expect(index).not.toHaveProperty('reviewNotes')
  })
})

describe('whole-file revert ids', () => {
  it('survive the structured clone IPC does, so the window can offer Undo', async () => {
    const store = twoHunks()
    const { result } = await store.revert('task', workspace, ['f.txt'])
    expect(Object.keys(result)).toContain('revertId')
    expect(structuredClone(result).revertId).toBe(result.revertId)
  })
})

describe('undo of a revert', () => {
  it('keeps a file that was edited elsewhere flagged and protected, as it was before the revert', async () => {
    const store = twoHunks()
    const [file] = await store.review('task', workspace, session)
    // The person edits another part of the file in their editor.
    writeFileSync(join(workspace, 'f.txt'), read('f.txt').replace('line 15', 'mine 15'))
    const reverted = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })
    await store.undoRevert('task', workspace, reverted.revertId!)
    expect(read('f.txt')).toBe(lines(30, { 5: 'five changed', 15: 'mine 15', 25: 'twenty-five changed' }))
    expect((await store.review('task', workspace, session))[0]).toMatchObject({ externallyModified: true })
    // A whole-file revert would still lose the person's edit, so it stays refused.
    expect((await store.revert('task', workspace, ['f.txt'])).result.skipped).toHaveLength(1)
    expect(read('f.txt')).toContain('mine 15')
  })

  it('tracks a restored deleted file correctly once the restore is undone, also after a restart', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'gone.txt'), 'bye\nnow\n')
    toolRemove(store, 'gone.txt')
    const [deleted] = await store.review('task', workspace, session)
    const restored = await store.revertHunks('task', workspace, { path: 'gone.txt', hunkIds: [deleted!.hunks[0]!.id], expectHeadHash: '' })
    expect(read('gone.txt')).toBe('bye\nnow\n')
    await store.undoRevert('task', workspace, restored.revertId!)
    expect(existsSync(join(workspace, 'gone.txt'))).toBe(false)
    for (const again of [store, new SessionChangeStore(storage)]) {
      const [file] = await again.review('task', workspace, session)
      expect(file).toMatchObject({ path: 'gone.txt', status: 'deleted' })
      expect(file!.externallyModified).toBeUndefined()
    }
  })

  it('touches no file when one of the saved copies is gone', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), 'a0\n')
    writeFileSync(join(workspace, 'b.txt'), 'b0\n')
    toolWrite(store, 'a.txt', 'a1\n')
    toolWrite(store, 'b.txt', 'b1\n')
    const { result } = await store.revert('task', workspace)
    expect(result.restored.sort()).toEqual(['a.txt', 'b.txt'])
    const blobs = join(storage, readdirSync(storage)[0]!, 'blobs')
    for (const name of readdirSync(blobs)) {
      if (readFileSync(join(blobs, name), 'utf8') === 'b1\n') writeFileSync(join(blobs, name), 'damaged')
    }
    await expect(store.undoRevert('task', workspace, result.revertId!)).rejects.toThrow(/missing or damaged/)
    expect(read('a.txt')).toBe('a0\n')
    expect(read('b.txt')).toBe('b0\n')
  })
})
