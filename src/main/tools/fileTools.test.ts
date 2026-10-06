import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, promises as fs } from 'node:fs'
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
  it('lists files, folders first', async () => {
    const r = await tool('list_files').execute({ path: '.' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(String(r.content)).toContain('src/')
    expect(String(r.content)).toContain('README.md')
  })

  it('reads a file', async () => {
    const r = await tool('read_file').execute({ path: 'README.md' }, ctx)
    expect(String(r.content)).toContain('Cubex rocks')
  })

  it('searches file contents', async () => {
    const r = await tool('search_files').execute({ query: 'TODO' }, ctx)
    expect(String(r.content)).toMatch(/app\.ts:2/)
  })

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

  it('marks write_file as ask (permission-gated)', () => {
    expect(tool('write_file').defaultPermission).toBe('ask')
    expect(tool('read_file').defaultPermission).toBe('allow')
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

  it('allows creating a brand-new file without a prior read', async () => {
    const fresh = createFileTools(root)
    const wf = fresh.find((t) => t.definition.name === 'write_file')!
    const r = await wf.execute({ path: 'created-new.txt', content: 'x' }, ctx)
    expect(r.isError).toBeFalsy()
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

  it('edit_file fails when old_string is not found or file is missing', async () => {
    writeFileSync(join(root, 'edit2.txt'), 'hello')
    await tool('read_file').execute({ path: 'edit2.txt' }, ctx)
    const notFound = await tool('edit_file').execute({ path: 'edit2.txt', old_string: 'nope', new_string: 'x' }, ctx)
    expect(notFound.isError).toBe(true)
    const missing = await tool('edit_file').execute({ path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ctx)
    expect(missing.isError).toBe(true)
    expect(String(missing.content)).toMatch(/does not exist/i)
  })
})

describe('paginated read_file', () => {
  beforeAll(() => {
    writeFileSync(join(root, 'pages.txt'), 'first\r\nsecond\r\nthird\r\nfourth\r\n')
    writeFileSync(join(root, 'empty.txt'), '')
    writeFileSync(join(root, 'long-line.txt'), 'x'.repeat(5_000) + '\nlast')
    writeFileSync(join(root, 'large.txt'), Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(80)}`).join('\n'))
  })

  it('preserves exact raw contents for existing callers, including CRLF', async () => {
    const result = await tool('read_file').execute({ path: 'pages.txt' }, ctx)
    expect(result.content).toBe('first\r\nsecond\r\nthird\r\nfourth\r\n')
  })

  it('uses 1-based offsets and returns numbered lines with a continuation hint', async () => {
    const result = await tool('read_file').execute({ path: 'pages.txt', offset: 2, limit: 2 }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('pages.txt: lines 2-3\n2: second\n3: third\n\nMore lines available. Continue with offset=4.')
    const last = await tool('read_file').execute({ path: 'pages.txt', offset: 4, limit: 2 }, ctx)
    expect(last.content).toBe('pages.txt: lines 4-4 (end of file)\n4: fourth')
  })

  it('can omit numbers explicitly and distinguishes empty files from an offset beyond EOF', async () => {
    const result = await tool('read_file').execute({ path: 'pages.txt', offset: 3, line_numbers: false }, ctx)
    expect(result.content).toBe('pages.txt: lines 3-4 (end of file)\nthird\nfourth')
    const past = await tool('read_file').execute({ path: 'pages.txt', offset: 20 }, ctx)
    expect(past.content).toBe('pages.txt: no lines at offset 20\n\nEnd of file: 4 lines.')
    const empty = await tool('read_file').execute({ path: 'empty.txt', line_numbers: true }, ctx)
    expect(empty.content).toBe('empty.txt: (empty file)')
  })

  it('reads pages from files over the legacy byte limit and keeps unpaginated limits', async () => {
    const legacy = await tool('read_file').execute({ path: 'large.txt' }, ctx)
    expect(legacy.isError).toBe(true)
    expect(legacy.content).toContain('Use read_file with offset=1')
    const page = await tool('read_file').execute({ path: 'large.txt', offset: 3_999, limit: 2 }, ctx)
    expect(page.isError).toBeFalsy()
    expect(page.content).toContain('3999: line 3999:')
    expect(page.content).toContain('4000: line 4000:')
    expect(page.content).toContain('(end of file)')
    expect(page.content).not.toContain('3998:')
  })

  it('bounds large lines and reports truncation without losing the following line', async () => {
    const page = await tool('read_file').execute({ path: 'long-line.txt', limit: 2 }, ctx)
    expect(page.content).toContain('[line truncated after 4096 characters]')
    expect(page.content).toContain('2: last')
    expect(String(page.content).length).toBeLessThan(4_300)
  })

  it('bounds multibyte output and tells the caller which line to read next', async () => {
    writeFileSync(join(root, 'multibyte.txt'), Array.from({ length: 80 }, () => '界'.repeat(4_000)).join('\n'))
    const page = await tool('read_file').execute({ path: 'multibyte.txt', limit: 80 }, ctx)
    expect(page.isError).toBeFalsy()
    expect(Buffer.byteLength(String(page.content))).toBeLessThan(256 * 1_024)
    const nextOffset = /Continue with offset=(\d+)/.exec(String(page.content))
    expect(nextOffset).not.toBeNull()
    const next = await tool('read_file').execute({ path: 'multibyte.txt', offset: Number(nextOffset![1]), limit: 1 }, ctx)
    expect(next.content).toContain(`${nextOffset![1]}: ${'界'.repeat(4_000)}`)
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

  it.each<Record<string, JSONValue>>([
    { offset: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: '2' },
    { limit: 0 }, { limit: 2_001 }, { limit: '2' }, { line_numbers: 'true' }
  ])('rejects invalid page inputs %j', async (input) => {
    const result = await tool('read_file').execute({ path: 'pages.txt', ...input }, ctx)
    expect(result.isError).toBe(true)
  })

  it('cancels before reading and does not unlock full overwrites', async () => {
    const fresh = createFileTools(root)
    const controller = new AbortController()
    controller.abort()
    const result = await fresh.find((item) => item.definition.name === 'read_file')!.execute(
      { path: 'pages.txt', limit: 4 }, { ...ctx, signal: controller.signal }
    )
    expect(result).toMatchObject({ isError: true, content: 'read_file cancelled.' })
    const blocked = await fresh.find((item) => item.definition.name === 'write_file')!.execute({ path: 'pages.txt', content: '' }, ctx)
    expect(blocked.isError).toBe(true)
  })

  it('honors cancellation while an asynchronous read is pending', async () => {
    const controller = new AbortController()
    const original = fs.stat.bind(fs)
    const spy = vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args: Parameters<typeof fs.stat>) => {
      const result = await original(...args)
      controller.abort()
      return result
    })
    try {
      const result = await tool('read_file').execute({ path: 'pages.txt', limit: 4 }, { ...ctx, signal: controller.signal })
      expect(result).toMatchObject({ isError: true, content: 'read_file cancelled.' })
    } finally {
      spy.mockRestore()
    }
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

  it('supports recursive globstars including zero directories and brace alternatives', async () => {
    const result = await tool('glob_files').execute({ path: 'discovery', pattern: '**/*.{ts,tsx}' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.content).split('\n')).toEqual([
      'discovery/.hidden.ts', 'discovery/src/app.ts', 'discovery/src/nested/test.ts', 'discovery/src/view.tsx', 'discovery/top.ts'
    ])
    expect(tool('glob_files').defaultPermission).toBe('allow')
  })

  it('matches bare filename patterns at any depth and anchors paths to the chosen folder', async () => {
    const bare = await tool('glob_files').execute({ path: 'discovery', pattern: '*.tsx' }, ctx)
    expect(bare.content).toBe('discovery/src/view.tsx')
    const anchored = await tool('glob_files').execute({ path: 'discovery', pattern: 'src/*.ts' }, ctx)
    expect(anchored.content).toBe('discovery/src/app.ts')
    const question = await tool('glob_files').execute({ path: 'discovery', pattern: 'src/???.ts' }, ctx)
    expect(question.content).toBe('discovery/src/app.ts')
    const windows = await tool('glob_files').execute({ path: 'discovery', pattern: 'src\\**\\test.?s' }, ctx)
    expect(String(windows.content).split('\n')).toEqual(['discovery/src/nested/test.js', 'discovery/src/nested/test.ts'])
  })

  it('reports extra results without claiming an exact-limit result was truncated', async () => {
    const result = await tool('glob_files').execute({ path: 'discovery', pattern: '*.ts', limit: 2 }, ctx)
    expect(result.content).toContain('Results truncated: more than 2 files matched.')
    expect(String(result.content).split('\n').filter((line) => line.startsWith('discovery/'))).toHaveLength(2)
    const exact = await tool('glob_files').execute({ path: 'discovery/src/nested', pattern: '*.ts', limit: 1 }, ctx)
    expect(exact.content).toBe('discovery/src/nested/test.ts')
    const missing = await tool('glob_files').execute({ path: 'discovery', pattern: '*.unknown' }, ctx)
    expect(missing.content).toBe('No matching files.')
  })

  it('bounds traversal even when a pattern has no matches', async () => {
    let visited = 0
    let closed = false
    const directory = {
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index < 25_000; index++) {
            visited++
            yield { name: `${index}.txt`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }
          }
        } finally {
          closed = true
        }
      }
    }
    const spy = vi.spyOn(fs, 'opendir').mockResolvedValueOnce(directory as Awaited<ReturnType<typeof fs.opendir>>)
    try {
      const result = await tool('glob_files').execute({ path: 'discovery', pattern: '*.unknown' }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('No matching files in the scanned entries.')
      expect(result.content).toContain('entry search budget was reached')
      expect(visited).toBeLessThan(25_000)
      expect(closed).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['discovery/.git', 'discovery/dist', 'discovery/src/node_modules/pkg'])('does not bypass excluded folders through explicit path %s', async (path) => {
    const result = await tool('glob_files').execute({ path, pattern: '*' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('excluded')
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

  it('cancels both before traversal and after an asynchronous directory open', async () => {
    const controller = new AbortController()
    controller.abort()
    const before = await tool('glob_files').execute({ pattern: '*' }, { ...ctx, signal: controller.signal })
    expect(before).toMatchObject({ isError: true, content: 'glob_files cancelled.' })

    const midflight = new AbortController()
    const original = fs.opendir.bind(fs)
    const spy = vi.spyOn(fs, 'opendir').mockImplementationOnce(async (...args: Parameters<typeof fs.opendir>) => {
      const result = await original(...args)
      midflight.abort()
      return result
    })
    try {
      const during = await tool('glob_files').execute({ pattern: '*' }, { ...ctx, signal: midflight.signal })
      expect(during).toMatchObject({ isError: true, content: 'glob_files cancelled.' })
    } finally {
      spy.mockRestore()
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

  it('keeps independently created tool sets from granting each other mutation rights', async () => {
    const path = 'independent-reads.txt'
    writeFileSync(join(root, path), 'parent state')
    const parent = createFileTools(root)
    const child = createFileTools(root)
    await freshTool(child, 'read_file').execute({ path }, ctx)
    expect((await freshTool(parent, 'edit_file').execute({ path, old_string: 'parent', new_string: 'other' }, ctx)).isError).toBe(true)
  })

  it('serializes competing edits from different task tool sets and refuses the stale second edit', async () => {
    const path = 'competing-edits.txt'
    writeFileSync(join(root, path), 'alpha beta')
    const first = createFileTools(root)
    const second = createFileTools(root)
    await freshTool(first, 'read_file').execute({ path }, ctx)
    await freshTool(second, 'read_file').execute({ path }, ctx)
    const results = await Promise.all([
      freshTool(first, 'edit_file').execute({ path, old_string: 'alpha', new_string: 'ALPHA' }, ctx),
      freshTool(second, 'edit_file').execute({ path, old_string: 'beta', new_string: 'BETA' }, ctx)
    ])
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    expect(results.find((result) => result.isError)?.content).toContain('changed since you read')
    expect(readFileSync(join(root, path), 'utf8')).toBe('ALPHA beta')
  })

  it('does not grant a read observation when the file changes during a paginated read', async () => {
    const path = 'changing-read.txt'
    writeFileSync(join(root, path), 'original')
    const fresh = createFileTools(root)
    const original = fs.stat.bind(fs)
    let calls = 0
    const spy = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (++calls === 2) writeFileSync(join(root, path), 'new manual contents')
      return original(...args)
    })
    try {
      const result = await freshTool(fresh, 'read_file').execute({ path, limit: 2 }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('changed while being read')
    } finally { spy.mockRestore() }
    expect((await freshTool(fresh, 'write_file').execute({ path, content: 'bad' }, ctx)).isError).toBe(true)
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

  it('never records a failed removal as a successful checkpoint mutation', async () => {
    const path = 'failed-remove.txt'
    writeFileSync(join(root, path), 'retain me')
    const onMutate = vi.fn()
    const fresh = createFileTools(root, onMutate)
    await freshTool(fresh, 'read_file').execute({ path }, ctx)
    const spy = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('permission denied'))
    try {
      expect((await freshTool(fresh, 'remove_file').execute({ path }, ctx)).isError).toBe(true)
      expect(onMutate).not.toHaveBeenCalled()
      expect(readFileSync(join(root, path), 'utf8')).toBe('retain me')
    } finally { spy.mockRestore() }
  })

  it('rejects directory removal, escapes, unread files, and cancellation without deleting anything', async () => {
    const path = 'protected-remove.txt'
    writeFileSync(join(root, path), 'safe')
    const fresh = createFileTools(root)
    const remove = freshTool(fresh, 'remove_file')
    for (const target of ['src', '.', '../outside.txt', path]) {
      expect((await remove.execute({ path: target }, ctx)).isError).toBe(true)
    }
    await freshTool(fresh, 'read_file').execute({ path }, ctx)
    const controller = new AbortController()
    controller.abort()
    expect((await remove.execute({ path }, { ...ctx, signal: controller.signal })).content).toBe('remove_file cancelled.')
    expect(readFileSync(join(root, path), 'utf8')).toBe('safe')
  })

  it('does not remove files through a directory symlink even after a full read', async () => {
    const directory = join(root, 'remove-real')
    const link = join(root, 'remove-alias')
    mkdirSync(directory)
    writeFileSync(join(directory, 'file.txt'), 'keep')
    symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const fresh = createFileTools(root)
      await freshTool(fresh, 'read_file').execute({ path: 'remove-alias/file.txt' }, ctx)
      const result = await freshTool(fresh, 'remove_file').execute({ path: 'remove-alias/file.txt' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('symbolic link')
      expect(readFileSync(join(directory, 'file.txt'), 'utf8')).toBe('keep')
    } finally { rmSync(link, { recursive: true, force: true }) }
  })
})

describe('bounded search_files', () => {
  it('searches an explicit HTML file without traversing its parent folder', async () => {
    const directory = join(root, 'portfolio-v2', 'designs')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'mission.html'), '<main>Portfolio</main>\r\n<a href="http://example.test">project</a>')
    writeFileSync(join(directory, 'other.html'), 'http://unrelated.test')
    const opendir = vi.spyOn(fs, 'opendir')
    try {
      const result = await tool('search_files').execute({ path: 'portfolio-v2/designs/mission.html', query: 'HTTP://' }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toBe('portfolio-v2/designs/mission.html:2: <a href="http://example.test">project</a>')
      expect(opendir).not.toHaveBeenCalled()
      const absent = await tool('search_files').execute({ path: 'portfolio-v2/designs/mission.html', query: 'skip' }, ctx)
      expect(absent).toMatchObject({ content: 'No matches for "skip".' })
      expect(absent.isError).toBeFalsy()
    } finally { opendir.mockRestore() }
  })

  it('searches explicitly selected extensionless text files and recognizes uppercase source extensions in folders', async () => {
    const directory = join(root, 'search-file-kinds')
    mkdirSync(directory)
    writeFileSync(join(directory, 'Dockerfile'), 'FROM alpine\n# needle')
    writeFileSync(join(directory, 'README.MD'), 'needle uppercase')
    const exact = await tool('search_files').execute({ path: 'search-file-kinds/Dockerfile', query: 'needle' }, ctx)
    expect(exact.isError).toBeFalsy()
    expect(exact.content).toContain('Dockerfile:2: # needle')
    const folder = await tool('search_files').execute({ path: 'search-file-kinds', query: 'needle' }, ctx)
    expect(folder.content).toContain('README.MD:1: needle uppercase')
  })

  it('enforces matching-line limits for exact files', async () => {
    writeFileSync(join(root, 'exact-hits.txt'), 'needle one\nneedle two\nneedle three')
    const result = await tool('search_files').execute({ path: 'exact-hits.txt', query: 'needle', limit: 2 }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('more than 2 lines matched')
    expect(result.content).not.toContain('needle three')
    const complete = await tool('search_files').execute({ path: 'exact-hits.txt', query: 'needle', limit: 3 }, ctx)
    expect(complete.content).not.toContain('truncated')
  })

  it('reports an exact-file size or decoding failure instead of claiming no matches', async () => {
    writeFileSync(join(root, 'search-too-large.txt'), 'needle'.repeat(50_000))
    writeFileSync(join(root, 'search-binary'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
    writeFileSync(join(root, 'search-invalid-utf8'), Buffer.from([0xff, 0xfe, 110, 101, 101, 100, 108, 101]))
    for (const [path, reason] of [
      ['search-too-large.txt', 'File too large'], ['search-binary', 'binary data'], ['search-invalid-utf8', 'not valid UTF-8']
    ]) {
      const result = await tool('search_files').execute({ path: path!, query: 'needle' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain(reason)
      expect(result.content).not.toContain('No matches')
    }
  })

  it('reports missing and unreadable explicit files as errors', async () => {
    const missing = await tool('search_files').execute({ path: 'does-not-exist.html', query: 'needle' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('ENOENT')
    const spy = vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('Access denied for file'), { code: 'EACCES' }))
    try {
      const denied = await tool('search_files').execute({ path: 'README.md', query: 'needle' }, ctx)
      expect(denied.isError).toBe(true)
      expect(denied.content).toContain('Access denied for file')
      expect(denied.content).not.toContain('No matches')
    } finally { spy.mockRestore() }
  })

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

  it('closes a selected file if cancellation arrives while it opens', async () => {
    const controller = new AbortController()
    const original = fs.open.bind(fs)
    const close = vi.fn()
    const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      const originalClose = handle.close.bind(handle)
      handle.close = async () => { close(); await originalClose() }
      controller.abort()
      return handle
    })
    try {
      const result = await tool('search_files').execute({ path: 'README.md', query: 'needle' }, { ...ctx, signal: controller.signal })
      expect(result).toMatchObject({ isError: true, content: 'search_files cancelled.' })
      expect(close).toHaveBeenCalledOnce()
    } finally { spy.mockRestore() }
  })

  it('returns an error result for escaping paths instead of rejecting the execution promise', async () => {
    const result = await tool('search_files').execute({ path: '..', query: 'secret' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('escapes the workspace')
  })

  it('skips linked directories and rejects explicit paths through symlinks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cubex-search-outside-'))
    const directory = join(root, 'search-scope')
    const link = join(directory, 'linked')
    mkdirSync(directory)
    writeFileSync(join(directory, 'inside.txt'), 'needle visible')
    writeFileSync(join(outside, 'secret.txt'), 'needle PRIVATE_OUTSIDE')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const normal = await tool('search_files').execute({ path: 'search-scope', query: 'needle' }, ctx)
      expect(normal.isError).toBeFalsy()
      expect(normal.content).toContain('inside.txt:1: needle visible')
      expect(normal.content).not.toContain('PRIVATE_OUTSIDE')
      const escaped = await tool('search_files').execute({ path: 'search-scope/linked', query: 'needle' }, ctx)
      expect(escaped.isError).toBe(true)
      expect(escaped.content).not.toContain('PRIVATE_OUTSIDE')
    } finally {
      rmSync(link, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports truncated hits and keeps exact-limit results complete', async () => {
    const directory = join(root, 'search-limits')
    mkdirSync(directory)
    writeFileSync(join(directory, 'hits.txt'), 'needle one\nneedle two\nneedle three')
    const truncated = await tool('search_files').execute({ path: 'search-limits', query: 'NEEDLE', limit: 2 }, ctx)
    expect(truncated.content).toContain('more than 2 lines matched')
    expect(truncated.content).not.toContain('needle three')
    const complete = await tool('search_files').execute({ path: 'search-limits', query: 'needle', limit: 3 }, ctx)
    expect(complete.content).not.toContain('truncated')
    expect(complete.content).toContain('hits.txt:3: needle three')
    expect((await tool('search_files').execute({ path: 'search-limits', query: 'needle', limit: 501 }, ctx)).isError).toBe(true)
  })

  it('cancels after asynchronous file opening and closes the opened handle', async () => {
    const controller = new AbortController()
    const original = fs.open.bind(fs)
    let closed = false
    const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => { closed = true; await close() }
      controller.abort()
      return handle
    })
    try {
      const result = await tool('search_files').execute({ path: 'search-limits', query: 'needle' }, { ...ctx, signal: controller.signal })
      expect(result).toMatchObject({ isError: true, content: 'search_files cancelled.' })
      expect(closed).toBe(true)
    } finally { spy.mockRestore() }
  })
})
