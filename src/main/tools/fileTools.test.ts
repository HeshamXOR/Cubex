import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, parseDiffMarker } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string
let tools: ReturnType<typeof createFileTools>
const tool = (name: string) => tools.find((t) => t.definition.name === name)!

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-ft-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# Hello\nworld\nCubex rocks')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n// TODO: fix\n')
  tools = createFileTools(root)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('file tools', () => {

  it('writes a file and reports diff stats', async () => {
    const r = await tool('write_file').execute({ path: 'note.txt', content: 'a\nb\nc' }, ctx)
    expect(r.isError).toBeFalsy()
    const diff = parseDiffMarker(String(r.content))
    expect(diff).toEqual({ added: 3, removed: 0 })
    const back = await tool('read_file').execute({ path: 'note.txt' }, ctx)
    expect(String(back.content)).toBe('a\nb\nc')
  })

  it('rejects path traversal outside the workspace', async () => {
    const r = await tool('read_file').execute({ path: '../../etc/passwd' }, ctx)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toMatch(/escapes the workspace/i)
  })

  it('refuses to overwrite an existing file that was not read this turn', async () => {
    const fresh = createFileTools(root)
    const wf = fresh.find((t) => t.definition.name === 'write_file')!
    const rf = fresh.find((t) => t.definition.name === 'read_file')!
    // README.md exists but this fresh tool-set has not read it → blocked.
    const blocked = await wf.execute({ path: 'README.md', content: 'nope' }, ctx)
    expect(blocked.isError).toBe(true)
    expect(String(blocked.content)).toMatch(/have not read it/i)
    // After reading, the write is allowed.
    await rf.execute({ path: 'README.md' }, ctx)
    const okWrite = await wf.execute({ path: 'README.md', content: '# Hello\nworld\nCubex rocks\nmore' }, ctx)
    expect(okWrite.isError).toBeFalsy()
  })

  it('edit_file replaces a unique old_string and reports a diff', async () => {
    writeFileSync(join(root, 'edit.txt'), 'alpha\nbeta\ngamma')
    await tool('read_file').execute({ path: 'edit.txt' }, ctx)
    const r = await tool('edit_file').execute(
      { path: 'edit.txt', old_string: 'beta', new_string: 'BETA' },
      ctx
    )
    expect(r.isError).toBeFalsy()
    const diff = parseDiffMarker(String(r.content))
    expect(diff).toEqual({ added: 1, removed: 1 })
    const back = await tool('read_file').execute({ path: 'edit.txt' }, ctx)
    expect(String(back.content)).toContain('BETA')
  })

  it('edit_file refuses an ambiguous old_string unless replace_all', async () => {
    writeFileSync(join(root, 'dup.txt'), 'x\nx\nx')
    await tool('read_file').execute({ path: 'dup.txt' }, ctx)
    const ambiguous = await tool('edit_file').execute({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx)
    expect(ambiguous.isError).toBe(true)
    expect(String(ambiguous.content)).toMatch(/appears 3 times/i)
    const all = await tool('edit_file').execute(
      { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true },
      ctx
    )
    expect(all.isError).toBeFalsy()
    const back = await tool('read_file').execute({ path: 'dup.txt' }, ctx)
    expect(String(back.content)).toBe('y\ny\ny')
  })
})

describe('paginated read_file', () => {
  beforeAll(() => {
    writeFileSync(join(root, 'pages.txt'), 'first\r\nsecond\r\nthird\r\nfourth\r\n')
    writeFileSync(join(root, 'empty.txt'), '')
    writeFileSync(join(root, 'long-line.txt'), 'x'.repeat(5_000) + '\nlast')
    writeFileSync(join(root, 'large.txt'), Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(80)}`).join('\n'))
  })

  it('uses 1-based offsets and returns numbered lines with a continuation hint', async () => {
    const result = await tool('read_file').execute({ path: 'pages.txt', offset: 2, limit: 2 }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('pages.txt: lines 2-3\n2: second\n3: third\n\nMore lines available. Continue with offset=4.')
    const last = await tool('read_file').execute({ path: 'pages.txt', offset: 4, limit: 2 }, ctx)
    expect(last.content).toBe('pages.txt: lines 4-4 (end of file)\n4: fourth')
  })

  it('does not authorize a full overwrite after a partial or truncated read', async () => {
    const fresh = createFileTools(root)
    const read = fresh.find((item) => item.definition.name === 'read_file')!
    const write = fresh.find((item) => item.definition.name === 'write_file')!
    await read.execute({ path: 'pages.txt', limit: 1 }, ctx)
    expect((await write.execute({ path: 'pages.txt', content: 'lost lines' }, ctx)).isError).toBe(true)
    await read.execute({ path: 'long-line.txt', limit: 2 }, ctx)
    expect((await write.execute({ path: 'long-line.txt', content: 'lost characters' }, ctx)).isError).toBe(true)
    // A complete numbered read still satisfies the existing read-before-write guard.
    await read.execute({ path: 'pages.txt', limit: 4 }, ctx)
    expect((await write.execute({ path: 'pages.txt', content: 'first\r\nsecond\r\nthird\r\nfourth\r\n' }, ctx)).isError).toBeFalsy()
  })
})

describe('glob_files', () => {
  beforeAll(() => {
    for (const folder of ['discovery/src/nested', 'discovery/src/node_modules/pkg', 'discovery/.git', 'discovery/dist', 'discovery/.venv']) {
      mkdirSync(join(root, folder), { recursive: true })
    }
    for (const path of ['top.ts', 'src/app.ts', 'src/view.tsx', 'src/nested/test.ts', 'src/nested/test.js', '.hidden.ts', 'src/node_modules/pkg/dependency.ts', '.git/config.ts', 'dist/generated.ts', '.venv/hidden.ts']) {
      writeFileSync(join(root, 'discovery', path), '')
    }
  })

  it.each<Record<string, JSONValue>>([
    { pattern: '../*' }, { pattern: 'src/../../*' }, { pattern: '/**' }, { pattern: 'C:\\**' },
    { pattern: '*.ts', path: '..' }, { pattern: '*.ts', limit: 0 }, { pattern: '*.ts', limit: 501 },
    { pattern: '' }, { pattern: '*.{ts,}' }, { pattern: '**/[ab].ts' }, { pattern: 'x'.repeat(513) }
  ])('rejects invalid or escaping inputs %j', async (input) => {
    const result = await tool('glob_files').execute(input, ctx)
    expect(result.isError).toBe(true)
  })

  it('skips directory symlinks, including loops and outside-workspace targets', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cubex-ft-outside-'))
    const externalLink = join(root, 'discovery', 'external')
    const loopLink = join(root, 'discovery', 'loop')
    try {
      writeFileSync(join(outside, 'secret.ts'), 'outside')
      symlinkSync(outside, externalLink, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(join(root, 'discovery'), loopLink, process.platform === 'win32' ? 'junction' : 'dir')
      const result = await tool('glob_files').execute({ path: 'discovery', pattern: '**/*.ts' }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).not.toContain('external')
      expect(result.content).not.toContain('loop')
      const internalAlias = await tool('glob_files').execute({ path: 'discovery/loop/src', pattern: '*' }, ctx)
      expect(internalAlias.isError).toBe(true)
      expect(internalAlias.content).toContain('cannot follow a symbolic link')
      const escaped = await tool('glob_files').execute({ path: 'discovery/external', pattern: '*' }, ctx)
      expect(escaped.isError).toBe(true)
      expect(escaped.content).toContain('escapes the workspace')
      const read = await tool('read_file').execute({ path: 'discovery/external/secret.ts', limit: 1 }, ctx)
      expect(read.isError).toBe(true)
      expect(read.content).toContain('escapes the workspace')
    } finally {
      rmSync(externalLink, { recursive: true, force: true })
      rmSync(loopLink, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('safe file mutations', () => {
  const freshTool = (set: ReturnType<typeof createFileTools>, name: string) => set.find((item) => item.definition.name === name)!

  it('requires an explicit read before a targeted edit', async () => {
    writeFileSync(join(root, 'unread-edit.txt'), 'known text')
    const fresh = createFileTools(root)
    const result = await freshTool(fresh, 'edit_file').execute({ path: 'unread-edit.txt', old_string: 'known', new_string: 'changed' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('have not read')
    expect(readFileSync(join(root, 'unread-edit.txt'), 'utf8')).toBe('known text')
  })

  it.each(['write_file', 'edit_file', 'remove_file'])('refuses %s when another actor changes a previously read file', async (name) => {
    const path = `stale-${name}.txt`
    writeFileSync(join(root, path), 'original content')
    const fresh = createFileTools(root)
    await freshTool(fresh, 'read_file').execute({ path }, ctx)
    writeFileSync(join(root, path), 'original content plus manual changes')
    const input: JSONValue = name === 'edit_file'
      ? { path, old_string: 'original', new_string: 'updated' }
      : name === 'write_file' ? { path, content: 'replacement' } : { path }
    const result = await freshTool(fresh, name).execute(input, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('changed since you read')
    expect(readFileSync(join(root, path), 'utf8')).toBe('original content plus manual changes')
  })

  it('allows edits only to the text inspected in a fresh page, without granting a full overwrite', async () => {
    const path = 'page-edit.txt'
    writeFileSync(join(root, path), 'outside\r\nvisible\r\nlast\r\n')
    const fresh = createFileTools(root)
    const read = freshTool(fresh, 'read_file')
    const edit = freshTool(fresh, 'edit_file')
    await read.execute({ path, offset: 2, limit: 1 }, ctx)
    expect((await edit.execute({ path, old_string: 'outside', new_string: 'hidden edit' }, ctx)).content).toContain('not included in the pages')
    expect((await edit.execute({ path, old_string: 'visible', new_string: 'updated' }, ctx)).isError).toBeFalsy()
    expect((await edit.execute({ path, old_string: 'updated', new_string: 'revised' }, ctx)).isError).toBeFalsy()
    expect((await freshTool(fresh, 'write_file').execute({ path, content: 'lost lines' }, ctx)).content).toContain('Only part')
    expect((await freshTool(fresh, 'remove_file').execute({ path }, ctx)).content).toContain('Only part')
    expect(readFileSync(join(root, path), 'utf8')).toBe('outside\r\nrevised\r\nlast\r\n')
  })

  it('requires a full read for replace_all and invalidates old full reads when a new version is only partly read', async () => {
    const path = 'page-replace-all.txt'
    writeFileSync(join(root, path), 'repeat\nrepeat')
    const fresh = createFileTools(root)
    const read = freshTool(fresh, 'read_file')
    const edit = freshTool(fresh, 'edit_file')
    await read.execute({ path, limit: 1 }, ctx)
    expect((await edit.execute({ path, old_string: 'repeat', new_string: 'changed', replace_all: true }, ctx)).content).toContain('Only part')
    await read.execute({ path }, ctx)
    writeFileSync(join(root, path), 'repeat\nrepeat\nmanual')
    await read.execute({ path, offset: 3, limit: 1 }, ctx)
    expect((await freshTool(fresh, 'write_file').execute({ path, content: 'clobbered' }, ctx)).content).toContain('Only part')
    expect((await edit.execute({ path, old_string: 'manual', new_string: 'preserved' }, ctx)).isError).toBeFalsy()
  })

  it('records successful writes, edits, and removal with before/after checkpoint contents', async () => {
    const path = 'checkpoint-lifecycle.txt'
    const snapshots: Array<{ before: string; existed: boolean; after?: string | null; existsNow: boolean }> = []
    const fresh = createFileTools(root, (absolute, before, existed, after) => snapshots.push({
      before: before.toString('utf8'), existed, after: after === null || after === undefined ? after : after.toString('utf8'), existsNow: existsSync(absolute)
    }))
    expect((await freshTool(fresh, 'write_file').execute({ path, content: 'first' }, ctx)).isError).toBeFalsy()
    expect((await freshTool(fresh, 'edit_file').execute({ path, old_string: 'first', new_string: 'second' }, ctx)).isError).toBeFalsy()
    const removed = await freshTool(fresh, 'remove_file').execute({ path }, ctx)
    expect(removed.isError).toBeFalsy()
    expect(parseDiffMarker(String(removed.content))).toEqual({ added: 0, removed: 1 })
    expect(snapshots).toEqual([
      { before: '', existed: false, after: 'first', existsNow: true },
      { before: 'first', existed: true, after: 'second', existsNow: true },
      { before: 'second', existed: true, after: null, existsNow: false }
    ])
    expect(existsSync(join(root, path))).toBe(false)
    expect(freshTool(fresh, 'remove_file').defaultPermission).toBe('ask')
  })
})

describe('bounded search_files', () => {

  it('does not bypass excluded folders or internal directory links through explicit file paths', async () => {
    const directory = join(root, 'search-explicit-policy')
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    mkdirSync(join(directory, 'source'))
    writeFileSync(join(directory, 'node_modules', 'skip.txt'), 'needle excluded')
    writeFileSync(join(directory, 'source', 'file.txt'), 'needle internal')
    const link = join(directory, 'alias')
    symlinkSync(join(directory, 'source'), link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const excluded = await tool('search_files').execute({ path: 'search-explicit-policy/node_modules/skip.txt', query: 'needle' }, ctx)
      expect(excluded.isError).toBe(true)
      expect(excluded.content).toContain('excluded')
      const linked = await tool('search_files').execute({ path: 'search-explicit-policy/alias/file.txt', query: 'needle' }, ctx)
      expect(linked.isError).toBe(true)
      expect(linked.content).toContain('cannot follow a symbolic link')
    } finally { rmSync(link, { recursive: true, force: true }) }
  })
})
