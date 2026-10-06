import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, parseDiffMarker, parseFileActivities } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-patch-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Tools = ReturnType<typeof createFileTools>
type Mutation = { path: string; before: string; existed: boolean; after: string | null }
const named = (tools: Tools, name: string) => tools.find((item) => item.definition.name === name)!
const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const run = (tools: Tools, text: string, signal?: AbortSignal) =>
  named(tools, 'apply_patch').execute({ patch: text } as JSONValue, signal ? { ...ctx, signal } : ctx)
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const write = (path: string, content: string | Buffer): void => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A tool set that has fully read each path, recording checkpoint callbacks. */
async function session(paths: string[] = [], mutations: Mutation[] = []): Promise<Tools> {
  const tools = createFileTools(root, (abs, before, existed, after) => mutations.push({
    path: abs.slice(root.length + 1).replace(/\\/g, '/'), before: before.toString('utf8'), existed, after: after === null || after === undefined ? null : after.toString('utf8')
  }))
  for (const path of paths) expect((await named(tools, 'read_file').execute({ path }, ctx)).isError).toBeFalsy()
  return tools
}

describe('apply_patch definition', () => {
  it('is registered with an ask permission and a single required patch string', () => {
    const tool = named(createFileTools(root), 'apply_patch')
    expect(tool.defaultPermission).toBe('ask')
    expect(tool.definition.inputSchema).toMatchObject({ type: 'object', required: ['patch'], properties: { patch: { type: 'string' } } })
    expect(tool.definition.description).toContain('*** Begin Patch')
  })

  it('rejects a missing or malformed patch without touching anything', async () => {
    const tools = createFileTools(root)
    for (const input of [{}, { patch: 5 }, { patch: '' }]) {
      const result = await named(tools, 'apply_patch').execute(input as JSONValue, ctx)
      expect(result.isError).toBe(true)
      expect(String(result.content)).toMatch(/requires a "patch"/)
    }
    const malformed = await run(tools, '*** Add File: a.txt\n+x')
    expect(malformed.isError).toBe(true)
    expect(String(malformed.content)).toMatch(/Begin Patch/)
  })
})

describe('apply_patch across files', () => {
  it('adds, updates and deletes files and reports each file with its counts', async () => {
    write('mixed/update.txt', 'one\ntwo\nthree\n')
    write('mixed/delete.txt', 'bye\nbye\n')
    const mutations: Mutation[] = []
    const tools = await session(['mixed/update.txt', 'mixed/delete.txt'], mutations)
    const result = await run(tools, patch(
      '*** Add File: mixed/nested/new.txt',
      '+hello',
      '+world',
      '*** Update File: mixed/update.txt',
      ' one',
      '-two',
      '+TWO',
      '+TWO-B',
      ' three',
      '*** Delete File: mixed/delete.txt'
    ))
    expect(result.isError).toBeFalsy()
    expect(read('mixed/nested/new.txt')).toBe('hello\nworld\n')
    expect(read('mixed/update.txt')).toBe('one\nTWO\nTWO-B\nthree\n')
    expect(existsSync(join(root, 'mixed/delete.txt'))).toBe(false)
    const text = String(result.content)
    expect(text).toContain('3 files')
    expect(text).toMatch(/added mixed\/nested\/new\.txt \(\+2 -0\)/)
    expect(text).toMatch(/modified mixed\/update\.txt \(\+2 -1\)/)
    expect(text).toMatch(/deleted mixed\/delete\.txt \(\+0 -2\)/)
    // Totals use the same marker as single-file tools.
    expect(parseDiffMarker(text)).toEqual({ added: 4, removed: 3 })
    expect(mutations).toEqual([
      { path: 'mixed/nested/new.txt', before: '', existed: false, after: 'hello\nworld\n' },
      { path: 'mixed/update.txt', before: 'one\ntwo\nthree\n', existed: true, after: 'one\nTWO\nTWO-B\nthree\n' },
      { path: 'mixed/delete.txt', before: 'bye\nbye\n', existed: true, after: null }
    ])
  })

  it('exposes per-file activity as harness metadata, never as model-visible text', async () => {
    write('activity/a.txt', 'a1\na2\n')
    write('activity/b.txt', 'b1\n')
    const tools = await session(['activity/a.txt', 'activity/b.txt'])
    const result = await run(tools, patch('*** Update File: activity/a.txt', ' a1', '-a2', '+A2', '*** Delete File: activity/b.txt', '*** Add File: activity/c.txt', '+c1'))
    expect(result.isError).toBeFalsy()
    const files = parseFileActivities(result.metadata)
    // Patch order, not execution order.
    expect(files).toEqual([
      { path: 'activity/a.txt', status: 'modified', added: 1, removed: 1, diff: expect.stringContaining('+A2') },
      { path: 'activity/b.txt', status: 'deleted', added: 0, removed: 1, diff: expect.stringContaining('-b1') },
      { path: 'activity/c.txt', status: 'added', added: 1, removed: 0, diff: expect.stringContaining('+c1') }
    ])
    // Per-file diffs travel as metadata; the text the model sees carries only the totals marker.
    expect(String(result.content)).not.toContain('diffbody')
    expect(parseDiffMarker(String(result.content))).toEqual({ added: 2, removed: 2 })
  })

  it('refuses to add over an existing file and changes nothing at all', async () => {
    write('exists/keep.txt', 'original')
    write('exists/other.txt', 'other\n')
    const tools = await session(['exists/other.txt'])
    const result = await run(tools, patch('*** Update File: exists/other.txt', '-other', '+OTHER', '*** Add File: exists/keep.txt', '+overwritten'))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/exists\/keep\.txt/)
    expect(String(result.content)).toMatch(/already exists/)
    expect(String(result.content)).toMatch(/no files were changed/i)
    expect(read('exists/keep.txt')).toBe('original')
    expect(read('exists/other.txt')).toBe('other\n')
  })

  it('validates every file before writing any and reports all the problems at once', async () => {
    write('batch/a.txt', 'alpha\n')
    write('batch/b.txt', 'beta\n')
    const tools = await session(['batch/a.txt', 'batch/b.txt'])
    const result = await run(tools, patch(
      '*** Update File: batch/a.txt', '-alpha', '+ALPHA',
      '*** Update File: batch/b.txt', '-not in the file', '+x',
      '*** Delete File: batch/missing.txt'
    ))
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toContain('batch/b.txt')
    expect(text).toContain('batch/missing.txt')
    expect(text).toMatch(/does not exist/)
    expect(read('batch/a.txt')).toBe('alpha\n')
    expect(read('batch/b.txt')).toBe('beta\n')
  })

  it('rejects a cut-off patch whole', async () => {
    write('cut/a.txt', 'a\n')
    const tools = await session(['cut/a.txt'])
    const result = await run(tools, ['*** Begin Patch', '*** Update File: cut/a.txt', '-a', '+A'].join('\n'))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/End Patch/)
    expect(read('cut/a.txt')).toBe('a\n')
  })

  it('applies two sections for the same file in order, and a delete followed by an add as a replacement', async () => {
    write('seq/a.txt', '1\n2\n3\n')
    write('seq/b.txt', 'old\n')
    const tools = await session(['seq/a.txt', 'seq/b.txt'])
    const result = await run(tools, patch(
      '*** Update File: seq/a.txt', '-1', '+one',
      '*** Update File: seq/a.txt', ' one', '-2', '+two',
      '*** Delete File: seq/b.txt',
      '*** Add File: seq/b.txt', '+new'
    ))
    expect(result.isError).toBeFalsy()
    expect(read('seq/a.txt')).toBe('one\ntwo\n3\n')
    expect(read('seq/b.txt')).toBe('new\n')
    expect(String(result.content)).toMatch(/modified seq\/b\.txt/)
  })

  it('rejects adding the same file twice and adding a file under another added file', async () => {
    const tools = createFileTools(root)
    const twice = await run(tools, patch('*** Add File: dup/a.txt', '+1', '*** Add File: dup/a.txt', '+2'))
    expect(twice.isError).toBe(true)
    expect(String(twice.content)).toMatch(/already exists/)
    const nested = await run(tools, patch('*** Add File: tree/a', '+1', '*** Add File: tree/a/b.txt', '+2'))
    expect(nested.isError).toBe(true)
    expect(existsSync(join(root, 'tree'))).toBe(false)
  })

  it('treats an add followed by a delete of the same new file as nothing to do', async () => {
    const tools = createFileTools(root)
    const result = await run(tools, patch('*** Add File: ghost/new.txt', '+x', '*** Delete File: ghost/new.txt', '*** Add File: ghost/real.txt', '+y'))
    expect(result.isError).toBeFalsy()
    expect(existsSync(join(root, 'ghost/new.txt'))).toBe(false)
    expect(read('ghost/real.txt')).toBe('y\n')
  })
})

describe('apply_patch moves', () => {
  it('moves a file with edits, reporting a deleted source and an added destination', async () => {
    write('mv/source.txt', 'keep\nchange\n')
    const mutations: Mutation[] = []
    const tools = await session(['mv/source.txt'], mutations)
    const result = await run(tools, patch('*** Update File: mv/source.txt', '*** Move to: mv/deep/dest.txt', ' keep', '-change', '+changed'))
    expect(result.isError).toBeFalsy()
    expect(existsSync(join(root, 'mv/source.txt'))).toBe(false)
    expect(read('mv/deep/dest.txt')).toBe('keep\nchanged\n')
    expect(String(result.content)).toMatch(/moved mv\/source\.txt -> mv\/deep\/dest\.txt \(\+1 -1\)/)
    expect(parseFileActivities(result.metadata)).toEqual([
      { path: 'mv/source.txt', status: 'deleted', added: 0, removed: 0 },
      { path: 'mv/deep/dest.txt', status: 'added', added: 1, removed: 1, diff: expect.stringContaining('+changed') }
    ])
    expect(mutations).toEqual([
      { path: 'mv/deep/dest.txt', before: '', existed: false, after: 'keep\nchanged\n' },
      { path: 'mv/source.txt', before: 'keep\nchange\n', existed: true, after: null }
    ])
  })

  it('supports a pure rename and refuses an existing destination or the same file', async () => {
    write('mv2/a.txt', 'a\n')
    write('mv2/taken.txt', 'taken\n')
    const tools = await session(['mv2/a.txt', 'mv2/taken.txt'])
    const taken = await run(tools, patch('*** Update File: mv2/a.txt', '*** Move to: mv2/taken.txt'))
    expect(taken.isError).toBe(true)
    expect(String(taken.content)).toMatch(/already exists/)
    const same = await run(tools, patch('*** Update File: mv2/a.txt', '*** Move to: mv2/a.txt'))
    expect(same.isError).toBe(true)
    expect(String(same.content)).toMatch(/same file/)
    const renamed = await run(tools, patch('*** Update File: mv2/a.txt', '*** Move to: mv2/b.txt'))
    expect(renamed.isError).toBeFalsy()
    expect(read('mv2/b.txt')).toBe('a\n')
    expect(existsSync(join(root, 'mv2/a.txt'))).toBe(false)
  })

  it('needs a full read to move a file', async () => {
    write('mv3/a.txt', '1\n2\n3\n')
    const tools = createFileTools(root)
    await named(tools, 'read_file').execute({ path: 'mv3/a.txt', limit: 2 }, ctx)
    const result = await run(tools, patch('*** Update File: mv3/a.txt', '*** Move to: mv3/b.txt'))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Only part/)
    expect(existsSync(join(root, 'mv3/a.txt'))).toBe(true)
  })
})

describe('apply_patch read-before-edit ledger', () => {
  it('requires a prior read for Update and Delete, and refuses stale files', async () => {
    write('ledger/a.txt', 'a\n')
    write('ledger/b.txt', 'b\n')
    const unread = createFileTools(root)
    const update = await run(unread, patch('*** Update File: ledger/a.txt', '-a', '+A'))
    expect(update.isError).toBe(true)
    expect(String(update.content)).toContain('have not read')
    const remove = await run(unread, patch('*** Delete File: ledger/b.txt'))
    expect(remove.isError).toBe(true)
    expect(String(remove.content)).toContain('have not read')
    const tools = await session(['ledger/a.txt'])
    write('ledger/a.txt', 'a changed by someone else\n')
    const stale = await run(tools, patch('*** Update File: ledger/a.txt', '-a changed by someone else', '+A'))
    expect(stale.isError).toBe(true)
    expect(String(stale.content)).toContain('changed since you read')
    expect(read('ledger/a.txt')).toBe('a changed by someone else\n')
    expect(read('ledger/b.txt')).toBe('b\n')
  })

  it('allows hunks only on text from pages the model read, and Delete needs a full read', async () => {
    write('ledger/paged.txt', 'one\ntwo\nthree\nfour\n')
    const tools = createFileTools(root)
    await named(tools, 'read_file').execute({ path: 'ledger/paged.txt', offset: 2, limit: 2 }, ctx)
    const outside = await run(tools, patch('*** Update File: ledger/paged.txt', '-one', '+ONE'))
    expect(outside.isError).toBe(true)
    expect(String(outside.content)).toContain('not included in the pages')
    const inside = await run(tools, patch('*** Update File: ledger/paged.txt', ' two', '-three', '+THREE'))
    expect(inside.isError).toBeFalsy()
    expect(read('ledger/paged.txt')).toBe('one\ntwo\nTHREE\nfour\n')
    const remove = await run(tools, patch('*** Delete File: ledger/paged.txt'))
    expect(remove.isError).toBe(true)
    expect(String(remove.content)).toContain('Only part')
  })

  it('does not let a partial read authorize appending at the end of the file', async () => {
    write('ledger/append.txt', 'one\ntwo\nthree\n')
    const tools = createFileTools(root)
    await named(tools, 'read_file').execute({ path: 'ledger/append.txt', limit: 1 }, ctx)
    const result = await run(tools, patch('*** Update File: ledger/append.txt', '@@', '+four'))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/full read|read the whole/i)
    expect(read('ledger/append.txt')).toBe('one\ntwo\nthree\n')
  })

  it('keeps the ledger valid afterwards so edit_file can continue without another read', async () => {
    write('ledger/continue.txt', 'x\ny\n')
    const tools = await session(['ledger/continue.txt'])
    expect((await run(tools, patch('*** Update File: ledger/continue.txt', '-x', '+X'))).isError).toBeFalsy()
    const edit = await named(tools, 'edit_file').execute({ path: 'ledger/continue.txt', old_string: 'y', new_string: 'Y' }, ctx)
    expect(edit.isError).toBeFalsy()
    expect(read('ledger/continue.txt')).toBe('X\nY\n')
    // A file the patch created counts as fully read.
    expect((await run(tools, patch('*** Add File: ledger/created.txt', '+made'))).isError).toBeFalsy()
    const overwrite = await named(tools, 'write_file').execute({ path: 'ledger/created.txt', content: 'rewritten' }, ctx)
    expect(overwrite.isError).toBeFalsy()
  })

  it('forgets a deleted file so it cannot be recreated by overwriting', async () => {
    write('ledger/gone.txt', 'bye\n')
    const tools = await session(['ledger/gone.txt'])
    expect((await run(tools, patch('*** Delete File: ledger/gone.txt'))).isError).toBeFalsy()
    const edit = await named(tools, 'edit_file').execute({ path: 'ledger/gone.txt', old_string: 'bye', new_string: 'x' }, ctx)
    expect(edit.isError).toBe(true)
  })
})

describe('apply_patch text fidelity', () => {
  it('preserves CRLF, a BOM and mixed endings on update while new files use LF', async () => {
    write('fidelity/crlf.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\nd\r\n', 'utf8')]))
    const tools = await session(['fidelity/crlf.txt'])
    const result = await run(tools, patch('*** Update File: fidelity/crlf.txt', ' a', '-b', '+B1', '+B2', ' c', '*** Add File: fidelity/new.txt', '+x', '+y'))
    expect(result.isError).toBeFalsy()
    const bytes = readFileSync(join(root, 'fidelity/crlf.txt'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('a\r\nB1\r\nB2\r\nc\nd\r\n')
    expect(read('fidelity/new.txt')).toBe('x\ny\n')
  })

  it('tolerates whitespace drift in context without rewriting the file whitespace', async () => {
    write('fidelity/tabs.go', 'func main() {\n\tprintln("a")\n\tprintln("b")\n}\n')
    const tools = await session(['fidelity/tabs.go'])
    const result = await run(tools, patch('*** Update File: fidelity/tabs.go', ' func main() {', '     println("a")', '-    println("b")', '+\tprintln("B")', ' }'))
    expect(result.isError).toBeFalsy()
    expect(read('fidelity/tabs.go')).toBe('func main() {\n\tprintln("a")\n\tprintln("B")\n}\n')
  })

  it('preserves a missing final newline', async () => {
    write('fidelity/nonl.txt', 'a\nb')
    const tools = await session(['fidelity/nonl.txt'])
    expect((await run(tools, patch('*** Update File: fidelity/nonl.txt', ' b', '+c'))).isError).toBeFalsy()
    expect(read('fidelity/nonl.txt')).toBe('a\nb\nc')
  })

  it('refuses to edit a binary file and shows the hunk diagnostics for a drifted hunk', async () => {
    write('fidelity/bin.dat', Buffer.from([0xff, 0xfe, 0x00, 0x61]))
    write('fidelity/src.ts', 'function beta() {\n  const value = compute(2)\n  return value\n}\n')
    const tools = await session(['fidelity/bin.dat', 'fidelity/src.ts'])
    const binary = await run(tools, patch('*** Update File: fidelity/bin.dat', '-a', '+b'))
    expect(binary.isError).toBe(true)
    expect(String(binary.content)).toMatch(/binary or not valid UTF-8/)
    const drift = await run(tools, patch('*** Update File: fidelity/src.ts', ' function beta() {', '-  const value = compute(3)', '+  const value = compute(4)', '   return value'))
    expect(drift.isError).toBe(true)
    expect(String(drift.content)).toMatch(/hunk 1/)
    expect(String(drift.content)).toMatch(/lines 1-3/)
    expect(String(drift.content)).toContain('compute(2)')
  })
})

describe('apply_patch atomicity and safety', () => {
  it('rolls back every file already written when a later write fails, without recording checkpoints', async () => {
    write('rollback/a.txt', 'a\n')
    write('rollback/b.txt', 'b\n')
    const mutations: Mutation[] = []
    const tools = await session(['rollback/a.txt', 'rollback/b.txt'], mutations)
    const original = fs.rename.bind(fs)
    let renames = 0
    // The second replacement fails; the first must be undone and the new file removed.
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renames++
      if (renames === 2) throw Object.assign(new Error('disk failure'), { code: 'EIO' })
      return original(...args)
    })
    try {
      const result = await run(tools, patch(
        '*** Add File: rollback/created/new.txt', '+n',
        '*** Update File: rollback/a.txt', '-a', '+A',
        '*** Update File: rollback/b.txt', '-b', '+B'
      ))
      expect(result.isError).toBe(true)
      expect(String(result.content)).toMatch(/rolled back/i)
      expect(String(result.content)).toContain('disk failure')
    } finally { spy.mockRestore() }
    expect(read('rollback/a.txt')).toBe('a\n')
    expect(read('rollback/b.txt')).toBe('b\n')
    expect(existsSync(join(root, 'rollback/created'))).toBe(false)
    expect(mutations).toEqual([])
    // The ledger still matches the restored bytes, so a corrected patch works without re-reading.
    expect((await run(tools, patch('*** Update File: rollback/a.txt', '-a', '+A'))).isError).toBeFalsy()
  })

  it('restores a file it already deleted, and the edits before it, when a later delete fails', async () => {
    write('rollback2/gone1.txt', 'precious one\n')
    write('rollback2/gone2.txt', 'precious two\n')
    write('rollback2/edit.txt', 'x\n')
    const mutations: Mutation[] = []
    const tools = await session(['rollback2/gone1.txt', 'rollback2/gone2.txt', 'rollback2/edit.txt'], mutations)
    const original = fs.unlink.bind(fs)
    let unlinks = 0
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
      if (++unlinks === 2) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      return original(...args)
    })
    try {
      const result = await run(tools, patch('*** Update File: rollback2/edit.txt', '-x', '+X', '*** Delete File: rollback2/gone1.txt', '*** Delete File: rollback2/gone2.txt'))
      expect(result.isError).toBe(true)
      expect(String(result.content)).toMatch(/rolled back/i)
    } finally { spy.mockRestore() }
    expect(read('rollback2/gone1.txt')).toBe('precious one\n')
    expect(read('rollback2/gone2.txt')).toBe('precious two\n')
    expect(read('rollback2/edit.txt')).toBe('x\n')
    expect(mutations).toEqual([])
    // Restored files are re-observed, so a corrected patch needs no new read.
    expect((await run(tools, patch('*** Delete File: rollback2/gone1.txt'))).isError).toBeFalsy()
  })

  it('rejects any path outside the workspace before reading or writing anything', async () => {
    write('safe/a.txt', 'a\n')
    const tools = await session(['safe/a.txt'])
    // A backslash is only a separator on Windows.
    for (const bad of ['../escape.txt', 'safe/../../escape.txt', ...(process.platform === 'win32' ? ['..\\escape.txt'] : [])]) {
      const result = await run(tools, patch('*** Update File: safe/a.txt', '-a', '+A', `*** Add File: ${bad}`, '+x'))
      expect(result.isError, bad).toBe(true)
      expect(String(result.content), bad).toMatch(/escapes the workspace/)
      expect(read('safe/a.txt')).toBe('a\n')
    }
    const moved = await run(tools, patch('*** Update File: safe/a.txt', '*** Move to: ../moved.txt'))
    expect(moved.isError).toBe(true)
    expect(existsSync(join(root, '..', 'moved.txt'))).toBe(false)
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false)
  })

  it('does not write through a junction or symlink that leaves the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cubex-patch-outside-'))
    try {
      write('links/real.txt', 'x\n')
      try { symlinkSync(outside, join(root, 'links', 'exit'), process.platform === 'win32' ? 'junction' : 'dir') } catch { return }
      const tools = createFileTools(root)
      const result = await run(tools, patch('*** Add File: links/exit/pwned.txt', '+owned'))
      expect(result.isError).toBe(true)
      expect(String(result.content)).toMatch(/escapes the workspace/)
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
    } finally {
      // Remove the link before its target: a dangling junction cannot be removed afterwards.
      rmSync(join(root, 'links', 'exit'), { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses to delete or move through a directory link inside the workspace', async () => {
    write('dirlink/real/file.txt', 'keep\n')
    try { symlinkSync(join(root, 'dirlink', 'real'), join(root, 'dirlink', 'alias'), process.platform === 'win32' ? 'junction' : 'dir') } catch { return }
    try {
      const tools = await session(['dirlink/alias/file.txt'])
      const remove = await run(tools, patch('*** Delete File: dirlink/alias/file.txt'))
      expect(remove.isError).toBe(true)
      expect(String(remove.content)).toMatch(/symbolic link/)
      expect(read('dirlink/real/file.txt')).toBe('keep\n')
    } finally { rmSync(join(root, 'dirlink', 'alias'), { recursive: true, force: true }) }
  })

  it('does not write anything when the turn is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const tools = createFileTools(root)
    const result = await run(tools, patch('*** Add File: cancelled/a.txt', '+x'), controller.signal)
    expect(result).toMatchObject({ isError: true, content: 'apply_patch cancelled.' })
    expect(existsSync(join(root, 'cancelled'))).toBe(false)
  })

  it('caps the number of files in one patch', async () => {
    const tools = createFileTools(root)
    const lines = Array.from({ length: 201 }, (_, index) => [`*** Add File: many/f${index}.txt`, '+x']).flat()
    const result = await run(tools, patch(...lines))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/at most 200/)
    expect(existsSync(join(root, 'many'))).toBe(false)
  })

  it('serializes with concurrent edits to the same file and refuses the stale one', async () => {
    write('race/a.txt', 'alpha beta\n')
    const first = await session(['race/a.txt'])
    const second = await session(['race/a.txt'])
    const results = await Promise.all([
      run(first, patch('*** Update File: race/a.txt', '-alpha beta', '+ALPHA beta')),
      named(second, 'edit_file').execute({ path: 'race/a.txt', old_string: 'beta', new_string: 'BETA' }, ctx)
    ])
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    expect(results.find((result) => result.isError)?.content).toContain('changed since you read')
  })
})
