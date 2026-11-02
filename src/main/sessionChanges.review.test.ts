import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionChangeStore } from './sessionChanges'

let root: string
let workspace: string
let storage: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-review-store-'))
  workspace = join(root, 'project')
  storage = join(root, 'storage')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const read = (rel: string): string => readFileSync(join(workspace, rel), 'utf8')
const lines = (count: number, edit: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => edit[i] ?? `line ${i}`).join('\n') + '\n'

/** Change a file the way a file tool does, then report the mutation like onMutate. */
function toolWrite(store: SessionChangeStore, rel: string, content: string | Buffer, turnId?: string): void {
  const path = join(workspace, rel)
  const existed = existsSync(path)
  const before = existed ? readFileSync(path) : Buffer.alloc(0)
  const after = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, after)
  store.record('task', path, before, existed, after, turnId)
}

/** A task with f.txt (30 lines) edited in two places 20 lines apart: two hunks. */
function twoHunks(): { store: SessionChangeStore; baseline: string; edited: string } {
  const store = new SessionChangeStore(storage)
  const baseline = lines(30)
  writeFileSync(join(workspace, 'f.txt'), baseline)
  const edited = lines(30, { 5: 'five changed', 25: 'twenty-five changed' })
  toolWrite(store, 'f.txt', edited)
  return { store, baseline, edited }
}

const session = { kind: 'session' } as const

describe('review: session scope', () => {
  it('lists hunks with ids, counts and the hash of the current bytes', async () => {
    const { store, edited } = twoHunks()
    const [file, ...rest] = await store.review('task', workspace, session)
    expect(rest).toEqual([])
    expect(file).toMatchObject({ path: 'f.txt', status: 'modified', added: 2, removed: 2, headHash: sha(edited) })
    expect(file!.hunks).toHaveLength(2)
    expect(file!.hunks.map((h) => h.state)).toEqual(['pending', 'pending'])
    expect(file!.hunks[0]!.lines).toContain('+five changed')
    expect(file!.updatedAt).toBeGreaterThan(0)
    // The older list API is unchanged.
    expect((await store.list('task', workspace))[0]).toMatchObject({ path: 'f.txt', added: 2, removed: 2 })
  })
})

describe('review: accepted hunks', () => {
  it('persists accept state by hunk id, valid only while the file keeps the accepted hash', async () => {
    const { store, edited } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [file!.hunks[0]!.id], headHash: file!.headHash! }])
    expect((await store.review('task', workspace, session))[0]!.hunks.map((h) => h.state)).toEqual(['accepted', 'pending'])
    // Survives a restart.
    const again = new SessionChangeStore(storage)
    expect((await again.review('task', workspace, session))[0]!.hunks.map((h) => h.state)).toEqual(['accepted', 'pending'])
    // A later edit changes the hash: everything resurfaces as pending.
    toolWrite(again, 'f.txt', edited.replace('line 15', 'line 15 edited'))
    expect((await again.review('task', workspace, session))[0]!.hunks.map((h) => h.state)).toEqual(['pending', 'pending', 'pending'])
  })

  it('ignores items for a stale hash, an unknown hunk or a path outside the workspace', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    await store.markReviewed('task', workspace, [
      { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], headHash: 'a'.repeat(64) },
      { path: 'f.txt', hunkIds: ['f'.repeat(40)], headHash: file!.headHash! },
      { path: '../outside.txt', hunkIds: ['x'], headHash: file!.headHash! }
    ])
    expect((await store.review('task', workspace, session))[0]!.hunks.map((h) => h.state)).toEqual(['pending', 'pending'])
  })
})

describe('revertHunks', () => {
  it('reverts one hunk against the current bytes and keeps the other', async () => {
    const { store, edited } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const [first, second] = file!.hunks
    const result = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [first!.id], expectHeadHash: file!.headHash! })
    expect(result).toMatchObject({ applied: [first!.id], conflicts: [] })
    expect(result.fuzzy).toBeUndefined()
    expect(result.revertId).toMatch(/^[a-f0-9-]{36}$/)
    expect(read('f.txt')).toBe(lines(30, { 25: 'twenty-five changed' }))
    expect(result.newHeadHash).toBe(sha(read('f.txt')))
    // Cubex did the write, so the file is not flagged as edited elsewhere; the other hunk remains.
    const [after] = await store.review('task', workspace, session)
    expect(after!.externallyModified).toBeUndefined()
    expect(after!.hunks.map((h) => h.id)).toEqual([second!.id])
    expect(edited).not.toBe(read('f.txt'))
  })

  it('returns a drift conflict and leaves the file alone when the hunk was edited since', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const hunk = file!.hunks[0]!
    const mine = read('f.txt').replace('five changed', 'five, my way')
    writeFileSync(join(workspace, 'f.txt'), mine)
    const result = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [hunk.id], expectHeadHash: file!.headHash! })
    expect(result).toMatchObject({ applied: [], conflicts: [{ hunkId: hunk.id, reason: 'drift' }], newHeadHash: sha(mine) })
    expect(result.revertId).toBeUndefined()
    expect(read('f.txt')).toBe(mine)
  })
})

describe('soft revert and undo', () => {
  it('undoes a hunk revert exactly, including accepted states, and re-tracks nothing extra', async () => {
    const { store, edited } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const [first, second] = file!.hunks
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [first!.id, second!.id], headHash: file!.headHash! }])
    const { revertId } = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [first!.id], expectHeadHash: file!.headHash! })
    expect(read('f.txt')).not.toBe(edited)
    await expect(store.undoRevert('task', workspace, revertId!)).resolves.toEqual({ restored: ['f.txt'] })
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe(edited)
    const [after] = await store.review('task', workspace, session)
    expect(after!.hunks.map((h) => h.state)).toEqual(['accepted', 'accepted'])
    expect(after!.externallyModified).toBeUndefined()
    // A record is used once.
    await expect(store.undoRevert('task', workspace, revertId!)).rejects.toThrow(/no longer|expired|not found/i)
  })

  it('returns a revertId from a whole-file revert and undoes it, tracking the file again', async () => {
    const { store, baseline, edited } = twoHunks()
    const { result } = await store.revert('task', workspace, ['f.txt'])
    expect(result.restored).toEqual(['f.txt'])
    expect(result.revertId).toMatch(/^[a-f0-9-]{36}$/)
    expect(read('f.txt')).toBe(baseline)
    expect(await store.list('task', workspace)).toEqual([])
    await expect(store.undoRevert('task', workspace, result.revertId!)).resolves.toEqual({ restored: ['f.txt'] })
    expect(read('f.txt')).toBe(edited)
    expect((await store.list('task', workspace)).map((c) => c.path)).toEqual(['f.txt'])
    // The restored baseline still reverts the file.
    expect((await store.revert('task', workspace)).result.restored).toEqual(['f.txt'])
    expect(read('f.txt')).toBe(baseline)
  })

  it('refuses to undo once the file changed after the revert, and keeps the newer content', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const { revertId } = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })
    const newer = `${read('f.txt')}appended later\n`
    writeFileSync(join(workspace, 'f.txt'), newer)
    await expect(store.undoRevert('task', workspace, revertId!)).rejects.toThrow(/changed/i)
    expect(read('f.txt')).toBe(newer)
  })

  it('refuses a record that names a file outside the workspace, and touches nothing', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const { revertId } = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'mine\n')
    // A record edited on disk to point somewhere else, with the hash of what is there so every other check passes.
    const task = readdirSync(storage)[0]!
    const recordPath = join(storage, task, 'reverts', `${revertId}.json`)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { files: Array<{ absPath: string; postRevertHash: string }> }
    record.files[0]!.absPath = outside
    record.files[0]!.postRevertHash = sha('mine\n')
    writeFileSync(recordPath, JSON.stringify(record))
    const reverted = read('f.txt')
    await expect(store.undoRevert('task', workspace, revertId!)).rejects.toThrow(/outside the workspace/)
    expect(readFileSync(outside, 'utf8')).toBe('mine\n')
    expect(read('f.txt')).toBe(reverted)
  })
})

describe('review notes for the model', () => {
  it('lists reverted hunks with line ranges and accepted counts, once, then clears them', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const [first, second] = file!.hunks
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [second!.id], headHash: file!.headHash! }])
    await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [first!.id], expectHeadHash: file!.headHash! })
    const notes = store.pendingReviewNotes('task')!
    expect(notes.startsWith('<review-state>')).toBe(true)
    expect(notes.trimEnd().endsWith('</review-state>')).toBe(true)
    expect(notes).toMatch(/f\.txt.*line 6/)
    expect(notes).toMatch(/accepted.*f\.txt.*1 hunk/i)
    expect(store.pendingReviewNotes('task')).toBe(notes)
    expect(store.consumeReviewNotes('task')).toBe(notes)
    expect(store.consumeReviewNotes('task')).toBeUndefined()
    expect(store.pendingReviewNotes('task')).toBeUndefined()
  })
})

describe('review: turn scope', () => {
  /** Turn m1 edits a.txt; turn m2 edits a.txt again and creates b.txt; turn m3 changes nothing. */
  function threeTurns(): SessionChangeStore {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'a.txt'), lines(30))
    store.beginTurn('task', 'm1')
    toolWrite(store, 'a.txt', lines(30, { 3: 'turn one' }), 'm1')
    store.beginTurn('task', 'm2')
    toolWrite(store, 'a.txt', lines(30, { 3: 'turn one', 20: 'turn two' }), 'm2')
    toolWrite(store, 'b.txt', 'new in two\n', 'm2')
    store.beginTurn('task', 'm3')
    return store
  }

  it('shows only what changed from the start of that turn on', async () => {
    const store = threeTurns()
    const two = await store.review('task', workspace, { kind: 'turn', messageId: 'm2' })
    expect(two.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([['a.txt', 'modified', 1, 1], ['b.txt', 'added', 1, 0]])
    expect(two[0]!.hunks).toHaveLength(1)
    expect(two[0]!.hunks[0]!.lines).toContain('+turn two')
    expect(two[0]!.hunks[0]!.lines).not.toContain('+turn one')
    const one = await store.review('task', workspace, { kind: 'turn', messageId: 'm1' })
    expect(one.find((f) => f.path === 'a.txt')!.hunks).toHaveLength(2)
    // The session scope is unchanged by turns.
    expect((await store.review('task', workspace, session)).find((f) => f.path === 'a.txt')!.hunks).toHaveLength(2)
  })

  it('keeps turns across a restart and drops them when a rewind removes the turn', async () => {
    threeTurns()
    const restarted = new SessionChangeStore(storage)
    expect((await restarted.review('task', workspace, { kind: 'turn', messageId: 'm2' })).map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    restarted.forgetTurnsSince('task', 'm2')
    expect(await restarted.review('task', workspace, { kind: 'turn', messageId: 'm2' })).toEqual([])
    expect((await restarted.review('task', workspace, { kind: 'turn', messageId: 'm1' })).map((f) => f.path)).toContain('a.txt')
  })
})

describe('whole-file hunks', () => {
  it('reverts the hunk of a created file by deleting it, and the hunk of a deleted file by restoring it', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'gone.txt'), 'bye\nnow\n')
    toolWrite(store, 'new.txt', 'hello\nworld\n')
    const removed = readFileSync(join(workspace, 'gone.txt'))
    unlinkSync(join(workspace, 'gone.txt'))
    store.record('task', join(workspace, 'gone.txt'), removed, true, null)
    const files = await store.review('task', workspace, session)
    const created = files.find((f) => f.path === 'new.txt')!
    const deleted = files.find((f) => f.path === 'gone.txt')!
    const first = await store.revertHunks('task', workspace, { path: 'new.txt', hunkIds: [created.hunks[0]!.id], expectHeadHash: created.headHash! })
    expect(first).toMatchObject({ applied: [created.hunks[0]!.id], conflicts: [], newHeadHash: null })
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
    const second = await store.revertHunks('task', workspace, { path: 'gone.txt', hunkIds: [deleted.hunks[0]!.id], expectHeadHash: '' })
    expect(second.applied).toEqual([deleted.hunks[0]!.id])
    expect(read('gone.txt')).toBe('bye\nnow\n')
    expect(second.newHeadHash).toBe(sha('bye\nnow\n'))
  })
})
