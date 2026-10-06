import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

  it('reports added and deleted files as one whole-file hunk and flags binary and oversize files', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'gone.txt'), 'bye\nnow\n')
    writeFileSync(join(workspace, 'img.bin'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(workspace, 'big.txt'), 'x\n'.repeat(1_200_000))
    toolWrite(store, 'new.txt', 'hello\nworld\n')
    const removed = readFileSync(join(workspace, 'gone.txt'))
    unlinkSync(join(workspace, 'gone.txt'))
    store.record('task', join(workspace, 'gone.txt'), removed, true, null)
    toolWrite(store, 'img.bin', Buffer.from([0, 9, 9, 9]))
    toolWrite(store, 'big.txt', 'y\n'.repeat(1_200_000))
    const byPath = Object.fromEntries((await store.review('task', workspace, session)).map((f) => [f.path, f]))
    expect(byPath['new.txt']).toMatchObject({ status: 'added', added: 2, headHash: sha('hello\nworld\n') })
    expect(byPath['new.txt']!.hunks).toHaveLength(1)
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', removed: 2, headHash: null })
    expect(byPath['img.bin']).toMatchObject({ binary: true, hunks: [] })
    expect(byPath['big.txt']).toMatchObject({ oversize: true, hunks: [] })
  })

  it('marks externally modified files', async () => {
    const { store } = twoHunks()
    writeFileSync(join(workspace, 'f.txt'), lines(30, { 5: 'five changed', 25: 'twenty-five changed', 10: 'mine' }))
    expect((await store.review('task', workspace, session))[0]).toMatchObject({ externallyModified: true })
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

  it('keeps accepted hunks accepted across a revert of another hunk', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const [first, second] = file!.hunks
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [second!.id], headHash: file!.headHash! }])
    await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [first!.id], expectHeadHash: file!.headHash! })
    expect((await store.review('task', workspace, session))[0]!.hunks.map((h) => h.state)).toEqual(['accepted'])
  })

  it('drops the file from review when its last hunk is reverted', async () => {
    const { store, baseline } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const result = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: file!.hunks.map((h) => h.id), expectHeadHash: file!.headHash! })
    expect(result.applied).toHaveLength(2)
    expect(read('f.txt')).toBe(baseline)
    expect(await store.review('task', workspace, session)).toEqual([])
  })

  it('applies a hunk on a changed file when its context still matches, and says so', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const hunk = file!.hunks[1]!
    writeFileSync(join(workspace, 'f.txt'), `my first line\n${read('f.txt')}`)
    const result = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [hunk.id], expectHeadHash: file!.headHash! })
    expect(result.applied).toEqual([hunk.id])
    expect(result.fuzzy).toEqual([{ hunkId: hunk.id, fuzz: 0, offset: 0, drift: true }])
    expect(read('f.txt')).toBe(`my first line\n${lines(30, { 5: 'five changed' })}`)
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

  it('reverts on an externally modified file without clearing the flag', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    writeFileSync(join(workspace, 'f.txt'), read('f.txt').replace('line 15', 'mine 15'))
    await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })
    expect(read('f.txt')).toBe(lines(30, { 15: 'mine 15', 25: 'twenty-five changed' }))
    expect((await store.review('task', workspace, session))[0]).toMatchObject({ externallyModified: true })
    // A whole-file revert would still lose the user's edit, so it stays refused.
    expect((await store.revert('task', workspace, ['f.txt'])).result.skipped).toHaveLength(1)
  })

  it('preserves CRLF and a BOM byte for byte', async () => {
    const store = new SessionChangeStore(storage)
    const crlf = (text: string): string => `﻿${text.replace(/\n/g, '\r\n')}`
    writeFileSync(join(workspace, 'w.txt'), crlf(lines(30)))
    toolWrite(store, 'w.txt', crlf(lines(30, { 5: 'five changed', 25: 'twenty-five changed' })))
    const [file] = await store.review('task', workspace, session)
    await store.revertHunks('task', workspace, { path: 'w.txt', hunkIds: [file!.hunks[1]!.id], expectHeadHash: file!.headHash! })
    expect(readFileSync(join(workspace, 'w.txt'), 'utf8')).toBe(crlf(lines(30, { 5: 'five changed' })))
  })

  it('rejects malformed requests before touching anything', async () => {
    const { store, edited } = twoHunks()
    const hash = sha(edited)
    await expect(store.revertHunks('task', workspace, { path: '../x', hunkIds: ['a'], expectHeadHash: hash })).rejects.toThrow(/workspace/i)
    await expect(store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [], expectHeadHash: hash })).rejects.toThrow(/hunk/i)
    await expect(store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: ['a'], expectHeadHash: 'nope' })).rejects.toThrow(/hash/i)
    await expect(store.revertHunks('task', workspace, { path: 'untracked.txt', hunkIds: ['a'], expectHeadHash: hash })).rejects.toThrow(/not changed/i)
    expect(read('f.txt')).toBe(edited)
    expect(readdirSync(workspace).sort()).toEqual(['f.txt'])
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

  it('undoes the deletion of a created file', async () => {
    const store = new SessionChangeStore(storage)
    toolWrite(store, 'new.txt', 'created\n')
    const { result } = await store.revert('task', workspace)
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
    await store.undoRevert('task', workspace, result.revertId!)
    expect(read('new.txt')).toBe('created\n')
    expect((await store.list('task', workspace)).map((c) => [c.path, c.status])).toEqual([['new.txt', 'added']])
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

  it('expires records when the next user message consumes the review notes, and across restarts until then', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const { revertId } = await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[0]!.id], expectHeadHash: file!.headHash! })
    const restarted = new SessionChangeStore(storage)
    expect(restarted.pendingReviewNotes('task')).toContain('f.txt')
    restarted.consumeReviewNotes('task')
    await expect(restarted.undoRevert('task', workspace, revertId!)).rejects.toThrow(/no longer|expired|not found/i)
    // The blob of the expired record is gone too.
    const task = readdirSync(storage)[0]!
    expect(readdirSync(join(storage, task, 'blobs')).length).toBeLessThanOrEqual(1)
  })

  it('rejects ids that are not record ids', async () => {
    const { store } = twoHunks()
    await expect(store.undoRevert('task', workspace, '../../etc/passwd')).rejects.toThrow(/revert/i)
    await expect(store.undoRevert('task', workspace, 'a'.repeat(36))).rejects.toThrow(/no longer|expired|not found/i)
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

  it('reports a whole-file revert and forgets a revert that was undone', async () => {
    const { store } = twoHunks()
    const { result } = await store.revert('task', workspace, ['f.txt'])
    expect(store.pendingReviewNotes('task')).toMatch(/f\.txt.*whole file/i)
    await store.undoRevert('task', workspace, result.revertId!)
    expect(store.pendingReviewNotes('task')).toBeUndefined()
  })

  it('is empty when nothing was reviewed', () => {
    const store = new SessionChangeStore(storage)
    expect(store.pendingReviewNotes('task')).toBeUndefined()
    expect(store.consumeReviewNotes('task')).toBeUndefined()
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

  it('returns nothing for a turn that changed no file and for an unknown message', async () => {
    const store = threeTurns()
    expect(await store.review('task', workspace, { kind: 'turn', messageId: 'm3' })).toEqual([])
    expect(await store.review('task', workspace, { kind: 'turn', messageId: 'nope' })).toEqual([])
  })

  it('keeps turns across a restart and drops them when a rewind removes the turn', async () => {
    threeTurns()
    const restarted = new SessionChangeStore(storage)
    expect((await restarted.review('task', workspace, { kind: 'turn', messageId: 'm2' })).map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    restarted.forgetTurnsSince('task', 'm2')
    expect(await restarted.review('task', workspace, { kind: 'turn', messageId: 'm2' })).toEqual([])
    expect((await restarted.review('task', workspace, { kind: 'turn', messageId: 'm1' })).map((f) => f.path)).toContain('a.txt')
  })

  it('reverts a hunk shown in the turn scope', async () => {
    const store = threeTurns()
    const [a] = await store.review('task', workspace, { kind: 'turn', messageId: 'm2' })
    const result = await store.revertHunks('task', workspace, { path: 'a.txt', hunkIds: [a!.hunks[0]!.id], expectHeadHash: a!.headHash! })
    expect(result.applied).toEqual([a!.hunks[0]!.id])
    expect(read('a.txt')).toBe(lines(30, { 3: 'turn one' }))
  })

  it('needs an explicit error for scopes it cannot serve yet', async () => {
    const store = threeTurns()
    await expect(store.review('task', workspace, { kind: 'bogus' } as never)).rejects.toThrow(/scope/i)
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

  it('refuses binary and oversize files at hunk level', async () => {
    const store = new SessionChangeStore(storage)
    writeFileSync(join(workspace, 'img.bin'), Buffer.from([0, 1]))
    toolWrite(store, 'img.bin', Buffer.from([0, 2]))
    await expect(store.revertHunks('task', workspace, { path: 'img.bin', hunkIds: ['a'.repeat(40)], expectHeadHash: sha(Buffer.from([0, 2])) })).rejects.toThrow(/whole/i)
  })
})

describe('review revision', () => {
  it('increases whenever review state changes', async () => {
    const { store } = twoHunks()
    const r0 = store.revision('task')
    const [file] = await store.review('task', workspace, session)
    expect(store.revision('task')).toBe(r0)
    await store.markReviewed('task', workspace, [{ path: 'f.txt', hunkIds: [file!.hunks[0]!.id], headHash: file!.headHash! }])
    const r1 = store.revision('task')
    expect(r1).toBeGreaterThan(r0)
    await store.revertHunks('task', workspace, { path: 'f.txt', hunkIds: [file!.hunks[1]!.id], expectHeadHash: file!.headHash! })
    expect(store.revision('task')).toBeGreaterThan(r1)
  })
})

describe('review: saved index', () => {
  const indexPath = (): string => join(storage, readdirSync(storage)[0]!, 'index.json')

  it('stays readable after a created file was reviewed through many versions', async () => {
    const store = new SessionChangeStore(storage)
    // A created file is one whole-file hunk, so every version of it is a hunk with a new id.
    const version = (n: number): string => lines(20_000, { 0: `version ${n}` })
    let previous = ''
    for (let n = 0; n < 20; n++) {
      toolWrite(store, 'big.txt', version(n))
      const [file] = await store.review('task', workspace, session)
      if (n === 18) previous = file!.hunks[0]!.id
    }
    expect(statSync(indexPath()).size).toBeLessThan(4 * 1024 * 1024)
    // The newest hunks are kept for a request that names one the file has moved past; the oldest are not.
    const saved = JSON.parse(readFileSync(indexPath(), 'utf8')) as { hunks: Record<string, unknown> }
    expect(saved.hunks[previous]).toBeDefined()
    expect(Object.keys(saved.hunks).length).toBeLessThan(5)
    // After a restart the task still lists the file.
    const again = new SessionChangeStore(storage)
    const [file] = await again.review('task', workspace, session)
    expect(file).toMatchObject({ path: 'big.txt', status: 'added', headHash: sha(version(19)) })
  })
})

describe('findHunk', () => {
  it('returns the hunk text for a comment, or undefined when the hunk is gone', async () => {
    const { store } = twoHunks()
    const [file] = await store.review('task', workspace, session)
    const id = file!.hunks[0]!.id
    expect((await store.findHunk('task', workspace, 'f.txt', id))?.lines).toContain('+five changed')
    expect(await store.findHunk('task', workspace, 'f.txt', 'f'.repeat(40))).toBeUndefined()
    expect(await store.findHunk('task', workspace, '../x', id)).toBeUndefined()
  })
})
