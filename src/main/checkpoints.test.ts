import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, promises as fs, mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore } from './checkpoints'

describe('CheckpointStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cubex-ckpt-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('restores a modified file to its pre-turn content on rewind', async () => {
    const store = new CheckpointStore()
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'original', 'utf8')

    const seq = store.beginTurn('c', 'm1')
    // Snapshot the pre-turn content, then mutate the file on disk (as a tool would).
    store.record('c', seq, file, 'original', true)
    writeFileSync(file, 'mutated', 'utf8')
    expect(readFileSync(file, 'utf8')).toBe('mutated')

    const { restored } = await store.rewind('c', 'm1')
    expect(restored).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('deletes a file recorded as newly created (existed:false) on rewind', async () => {
    const store = new CheckpointStore()
    const file = join(dir, 'created.txt')

    const seq = store.beginTurn('c', 'm1')
    // The file did not exist before the turn — rewind should remove it entirely.
    store.record('c', seq, file, '', false)
    writeFileSync(file, 'brand new', 'utf8')
    expect(existsSync(file)).toBe(true)

    const { restored } = await store.rewind('c', 'm1')
    expect(restored).toEqual([file])
    expect(existsSync(file)).toBe(false)
  })

  it('preserves later manual edits and does not rewind any file when preflight conflicts', async () => {
    const store = new CheckpointStore()
    const first = join(dir, 'a.txt')
    const second = join(dir, 'b.txt')
    const seq = store.beginTurn('c', 'm1')
    writeFileSync(first, 'tool a')
    writeFileSync(second, 'tool b')
    store.record('c', seq, first, 'original a', true, 'tool a')
    store.record('c', seq, second, 'original b', true, 'tool b')
    writeFileSync(second, 'manual changes')
    await expect(store.rewind('c', 'm1')).rejects.toThrow('current files were preserved')
    expect(readFileSync(first, 'utf8')).toBe('tool a')
    expect(readFileSync(second, 'utf8')).toBe('manual changes')
    expect(store.countSince('c', 'm1')).toBe(2)
  })

  it('restores a removed file but refuses to overwrite a manually recreated file', async () => {
    const store = new CheckpointStore()
    const file = join(dir, 'removed.txt')
    const seq = store.beginTurn('c', 'm1')
    store.record('c', seq, file, 'original', true, null)
    writeFileSync(file, 'new manual file')
    await expect(store.rewind('c', 'm1')).rejects.toThrow('Rewind stopped')
    expect(readFileSync(file, 'utf8')).toBe('new manual file')
    rmSync(file)
    await store.rewind('c', 'm1')
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('retains inaccessible snapshots for retry after a partial restore', async () => {
    const store = new CheckpointStore()
    const first = join(dir, 'accessible.txt')
    const second = join(dir, 'locked.txt')
    const seq = store.beginTurn('c', 'm1')
    writeFileSync(first, 'changed a')
    writeFileSync(second, 'changed b')
    store.record('c', seq, first, 'original a', true, 'changed a')
    store.record('c', seq, second, 'original b', true, 'changed b')
    const write = fs.writeFile.bind(fs)
    const mock = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === second) throw new Error('File locked')
      return write(...args)
    })
    await expect(store.rewind('c', 'm1')).rejects.toThrow('restored 1 file(s)')
    expect(store.countSince('c', 'm1')).toBe(1)
    expect(readFileSync(first, 'utf8')).toBe('original a')
    mock.mockRestore()
    await store.rewind('c', 'm1')
    expect(readFileSync(second, 'utf8')).toBe('original b')
  })

  it('refuses a parent directory replaced with a junction to another location', async () => {
    const store = new CheckpointStore()
    const parent = join(dir, 'project')
    const other = join(dir, 'outside')
    mkdirSync(parent)
    mkdirSync(other)
    const file = join(parent, 'target.txt')
    writeFileSync(file, 'tool contents')
    writeFileSync(join(other, 'target.txt'), 'tool contents')
    store.record('c', store.beginTurn('c', 'm1'), file, 'original', true, 'tool contents')
    renameSync(parent, join(dir, 'old-project'))
    symlinkSync(other, parent, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(store.rewind('c', 'm1')).rejects.toThrow('Rewind stopped')
      expect(readFileSync(join(other, 'target.txt'), 'utf8')).toBe('tool contents')
    } finally { unlinkSync(parent) }
  })
})

describe('CheckpointStore restore with undo', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cubex-restore-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  /** One turn that modified `a.txt`, created `made.txt` and removed `gone.txt`, as the file tools report them. */
  function oneEditingTurn(store: CheckpointStore) {
    const a = join(dir, 'a.txt')
    const made = join(dir, 'made.txt')
    const gone = join(dir, 'gone.txt')
    writeFileSync(a, 'a before')
    writeFileSync(gone, 'gone before')
    const seq = store.beginTurn('c', 'm1')
    store.record('c', seq, a, 'a before', true, 'a after')
    store.record('c', seq, made, '', false, 'made after')
    store.record('c', seq, gone, 'gone before', true, null)
    writeFileSync(a, 'a after')
    writeFileSync(made, 'made after')
    rmSync(gone)
    return { a, made, gone }
  }

  it('starts from the first message that began a turn, so a later turn is still put back', async () => {
    const store = new CheckpointStore()
    const file = join(dir, 'later.txt')
    writeFileSync(file, 'v0')
    // m1 ran without file tools and has no turn of its own; m2 edited the file.
    store.record('c', store.beginTurn('c', 'm2'), file, 'v0', true, 'v1')
    writeFileSync(file, 'v1')
    const result = await store.restore('c', ['m1', 'm2'])
    expect(result.restored).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe('v0')
  })

  it('restores to before the first of several turns that edited the same file, or just the later one', async () => {
    const store = new CheckpointStore()
    const file = join(dir, 'twice.txt')
    writeFileSync(file, 'original')
    store.record('c', store.beginTurn('c', 'm1'), file, 'original', true, 'one')
    store.record('c', store.beginTurn('c', 'm2'), file, 'one', true, 'two')
    writeFileSync(file, 'two')
    await store.restore('c', ['m2'])
    expect(readFileSync(file, 'utf8')).toBe('one')
    await store.restore('c', ['m1', 'm2'])
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('leaves a file edited outside Cubex alone, says why, and still restores the others', async () => {
    const store = new CheckpointStore()
    const { a, made, gone } = oneEditingTurn(store)
    writeFileSync(a, 'a edited by hand')
    const preview = await store.preview('c', ['m1'])
    expect(preview.blocked).toEqual([{ path: a, reason: 'Changed outside Cubex since its last edit' }])
    const result = await store.restore('c', ['m1'])
    expect(result.restored).toEqual([made, gone])
    expect(result.skipped).toEqual([{ path: a, reason: 'Changed outside Cubex since its last edit' }])
    expect(readFileSync(a, 'utf8')).toBe('a edited by hand')
    expect(existsSync(made)).toBe(false)
    expect(readFileSync(gone, 'utf8')).toBe('gone before')
    // The skipped file keeps its snapshot, so resolving the conflict by hand lets a retry finish the job.
    expect(store.countSince('c', 'm1')).toBe(1)
  })

  it('reports a file it could not write and still restores the rest', async () => {
    const store = new CheckpointStore()
    const { a, made } = oneEditingTurn(store)
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === a) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return write(...args)
    })
    const result = await store.restore('c', ['m1'])
    expect(result.failed).toEqual([{ path: a, reason: 'Another program is using it' }])
    expect(result.restored).toContain(made)
    expect(store.countSince('c', 'm1')).toBe(1)
    expect(result.undoId).toBeTruthy()
  })

  it('undoes a restore: files go back and the same point can be restored again', async () => {
    const store = new CheckpointStore()
    const { a, made, gone } = oneEditingTurn(store)
    const { undoId } = await store.restore('c', ['m1'])
    expect(readFileSync(a, 'utf8')).toBe('a before')
    expect(existsSync(made)).toBe(false)
    expect(existsSync(gone)).toBe(true)

    const undone = await store.undo('c', undoId!)
    expect(undone.restored.sort()).toEqual([a, made, gone].sort())
    expect(readFileSync(a, 'utf8')).toBe('a after')
    expect(readFileSync(made, 'utf8')).toBe('made after')
    expect(existsSync(gone)).toBe(false)

    const again = await store.restore('c', ['m1'])
    expect(again.restored).toHaveLength(3)
    expect(readFileSync(a, 'utf8')).toBe('a before')
  })

  it('refuses an undo when a restored file changed afterwards and touches nothing', async () => {
    const store = new CheckpointStore()
    const { a, made } = oneEditingTurn(store)
    const { undoId } = await store.restore('c', ['m1'])
    writeFileSync(a, 'edited after the restore')
    await expect(store.undo('c', undoId!)).rejects.toThrow('Undo stopped')
    expect(readFileSync(a, 'utf8')).toBe('edited after the restore')
    expect(existsSync(made)).toBe(false)
  })
})
