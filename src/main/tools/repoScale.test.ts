import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

/** list_files, glob_files and search_files on repositories with ignored, generated and huge folders. */

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
const base = mkdtempSync(join(tmpdir(), 'cubex-scale-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let counter = 0

function repo(files: Record<string, string>): string {
  const root = join(base, `repo${counter++}`)
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
const run = async (root: string, tool: string, input: JSONValue): Promise<string> => {
  const result = await createFileTools(root).find((item) => item.definition.name === tool)!.execute(input, ctx)
  return String(result.content)
}
const lines = (text: string): string[] => text.split('\n')

describe('list_files', () => {
  it('hides entries ignored by .gitignore and the always-skipped folders, and says how many it hid', async () => {
    const root = repo({
      '.gitignore': '*.log\nbuild/\n!keep.log\n',
      'a.ts': '', 'debug.log': '', 'keep.log': '', 'build/x.js': '', 'src/main.ts': '', 'node_modules/dep/index.js': '', '.git/HEAD': ''
    })
    const text = await run(root, 'list_files', { path: '.' })
    expect(lines(text).slice(0, 4)).toEqual(['src/', '.gitignore', 'a.ts', 'keep.log'])
    expect(text).not.toContain('debug.log')
    expect(text).not.toContain('build/')
    expect(text).not.toContain('node_modules')
    expect(text).toMatch(/hidden by \.gitignore/i)
  })

  it('shows the contents of an ignored folder when it is chosen explicitly', async () => {
    const root = repo({ '.gitignore': 'build/\n', 'build/x.js': '', 'build/y.js': '' })
    expect(lines(await run(root, 'list_files', { path: 'build' }))).toEqual(['x.js', 'y.js'])
  })

  it('applies nested ignore files within their folder', async () => {
    const root = repo({ 'pkg/.gitignore': '*.gen.ts\n', 'pkg/a.ts': '', 'pkg/a.gen.ts': '', 'other/b.gen.ts': '' })
    expect(await run(root, 'list_files', { path: 'pkg' })).not.toContain('a.gen.ts')
    expect(await run(root, 'list_files', { path: 'other' })).toContain('b.gen.ts')
  })

  it('caps very large folders and reports how many entries were not shown', async () => {
    const files: Record<string, string> = { '.gitignore': '*.tmp\n' }
    for (let i = 0; i < 1200; i++) files[`big/f${String(i).padStart(4, '0')}.txt`] = ''
    for (let i = 0; i < 50; i++) files[`big/skipped${i}.tmp`] = ''
    const text = await run(repo(files), 'list_files', { path: 'big' })
    const entries = lines(text).filter((line) => line.startsWith('f') && line.endsWith('.txt'))
    expect(entries).toHaveLength(500)
    expect(entries[0]).toBe('f0000.txt')
    expect(entries[499]).toBe('f0499.txt')
    expect(text).toMatch(/700 more entries not shown/)
    expect(text).toMatch(/narrow/i)
    expect(text.length).toBeLessThan(12_000)
  })

  it('lists a small folder exactly as before: folders first, then names, with no notice', async () => {
    const root = repo({ 'b.txt': '', 'a.txt': '', 'z/y.txt': '', 'c/d.txt': '' })
    expect(lines(await run(root, 'list_files', { path: '.' }))).toEqual(['c/', 'z/', 'a.txt', 'b.txt'])
  })

  it('treats the always-skipped folder names case-insensitively where the file system does', async () => {
    const root = repo({ 'Node_Modules/dep/index.js': '', 'src/a.ts': '' })
    const text = await run(root, 'list_files', { path: '.' })
    if (process.platform === 'win32') expect(text).not.toContain('Node_Modules')
    expect(text).toContain('src/')
  })
})

describe('glob_files', () => {
  it('skips ignored folders so generated output cannot crowd out the sources', async () => {
    const files: Record<string, string> = { '.gitignore': 'build/\n*.gen.ts\n', 'src/a.ts': '', 'src/b.ts': '', 'src/c.gen.ts': '' }
    for (let i = 0; i < 40; i++) files[`build/d${i}/f.ts`] = ''
    const text = await run(repo(files), 'glob_files', { pattern: '**/*.ts', limit: 10 })
    expect(lines(text).filter(Boolean)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('never enters an ignored folder', async () => {
    const root = repo({ '.gitignore': 'build/\n', 'build/deep/x.ts': '', 'src/a.ts': '' })
    const opened: string[] = []
    const original = fs.opendir.bind(fs)
    const spy = vi.spyOn(fs, 'opendir').mockImplementation(((path: string, ...rest: unknown[]) => {
      opened.push(String(path))
      return (original as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.opendir)
    try { await run(root, 'glob_files', { pattern: '**/*.ts' }) } finally { spy.mockRestore() }
    expect(opened.some((path) => path.includes('build'))).toBe(false)
    expect(opened.some((path) => path.endsWith('src'))).toBe(true)
  })

  it('searches an ignored folder when it is chosen explicitly', async () => {
    const root = repo({ '.gitignore': 'build/\n', 'build/x.ts': '', 'build/sub/y.ts': '', 'src/a.ts': '' })
    expect(lines(await run(root, 'glob_files', { pattern: '**/*.ts', path: 'build' })).filter(Boolean)).toEqual(['build/sub/y.ts', 'build/x.ts'])
  })

  it('honors negation and nested ignore files', async () => {
    const root = repo({
      '.gitignore': '*.ts\n!keep.ts\n', 'a.ts': '', 'keep.ts': '', 'sub/.gitignore': '!sub-keep.ts\n', 'sub/sub-keep.ts': '', 'sub/other.ts': ''
    })
    expect(lines(await run(root, 'glob_files', { pattern: '**/*.ts' })).filter(Boolean)).toEqual(['keep.ts', 'sub/sub-keep.ts'])
  })

  it('reports how many matches were not shown', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.ts`] = ''
    const text = await run(repo(files), 'glob_files', { pattern: '*.ts', limit: 10 })
    expect(lines(text).filter((line) => line.endsWith('.ts'))).toHaveLength(10)
    expect(text).toMatch(/20 more files matched but are not shown/)
    expect(text).toMatch(/narrow/i)
  })

  it('does not claim truncation when everything fits', async () => {
    const text = await run(repo({ 'a.ts': '', 'b.ts': '' }), 'glob_files', { pattern: '*.ts', limit: 2 })
    expect(text).not.toMatch(/more files|truncated/i)
  })
})

describe('search_files', () => {
  it('skips ignored folders and files, but searches an explicitly chosen ignored file or folder', async () => {
    const root = repo({
      '.gitignore': 'build/\n*.log\n', 'src/a.ts': 'needle in source\n', 'build/b.ts': 'needle in build\n', 'debug.log': 'needle in log\n'
    })
    const all = await run(root, 'search_files', { query: 'needle' })
    expect(all).toContain('src/a.ts:1')
    expect(all).not.toContain('build/b.ts')
    expect(all).not.toContain('debug.log')
    expect(await run(root, 'search_files', { query: 'needle', path: 'build' })).toContain('build/b.ts:1')
    expect(await run(root, 'search_files', { query: 'needle', path: 'debug.log' })).toContain('debug.log:1')
  })

  it('keeps substring search literal and case-insensitive by default', async () => {
    const root = repo({ 'a.ts': 'a.b\naxb\nA.B\n' })
    const text = await run(root, 'search_files', { query: 'a.b' })
    expect(text).toContain('a.ts:1')
    expect(text).toContain('a.ts:3')
    expect(text).not.toContain('a.ts:2')
    const exact = await run(root, 'search_files', { query: 'a.b', case_sensitive: true })
    expect(exact).toContain('a.ts:1')
    expect(exact).not.toContain('a.ts:3')
  })
})

describe('search_files regular expressions', () => {
  const root = repo({
    'a.ts': 'export const needle42 = 1\nconst other = 2\nexport function NEEDLE7() {}\n',
    'b.md': 'plain text\nneedle without digits\n'
  })

  it('matches a regular expression per line, case-insensitively unless asked otherwise', async () => {
    const text = await run(root, 'search_files', { query: 'needle\\d+', regex: true })
    expect(text).toContain('a.ts:1')
    expect(text).toContain('a.ts:3')
    expect(text).not.toContain('b.md')
    const exact = await run(root, 'search_files', { query: 'needle\\d+', regex: true, case_sensitive: true })
    expect(exact).toContain('a.ts:1')
    expect(exact).not.toContain('a.ts:3')
  })

  it('supports anchors, alternation and classes', async () => {
    expect(await run(root, 'search_files', { query: '^export (const|function)', regex: true })).toMatch(/a\.ts:1[\s\S]*a\.ts:3/)
    expect(await run(root, 'search_files', { query: '^const', regex: true })).toContain('a.ts:2')
    expect(await run(root, 'search_files', { query: '[0-9]+ =', regex: true })).toContain('a.ts:1')
  })

  it('reports a syntax error instead of searching', async () => {
    const text = await run(root, 'search_files', { query: '(unclosed', regex: true })
    expect(text).toMatch(/invalid regular expression/i)
  })

  it('rejects an over-long pattern and a non-boolean flag', async () => {
    expect(await run(root, 'search_files', { query: 'a'.repeat(600), regex: true })).toMatch(/at most 500/i)
    expect(await run(root, 'search_files', { query: 'a', regex: 'yes' })).toMatch(/regex must be a boolean/i)
    expect(await run(root, 'search_files', { query: 'a', case_sensitive: 1 })).toMatch(/case_sensitive must be a boolean/i)
  })

  it('stops a pattern that backtracks catastrophically and says so, without hanging', async () => {
    const hostile = repo({ 'hostile.txt': `${'a'.repeat(60)}!\n`, 'fine.txt': 'aaa\n' })
    const start = Date.now()
    const text = await run(hostile, 'search_files', { query: '(a+)+$', regex: true })
    expect(Date.now() - start).toBeLessThan(8_000)
    expect(text).toMatch(/too long|too expensive|time budget/i)
    expect(text).toMatch(/regex/i)
    // The tool is still usable afterwards.
    expect(await run(hostile, 'search_files', { query: 'fine', regex: false })).toContain('No matches')
    expect(await run(hostile, 'search_files', { query: 'a{3}', regex: true, path: 'fine.txt' })).toContain('fine.txt:1')
  }, 20_000)

  it('keeps the results found before an expensive file stopped the search', async () => {
    const hostile = repo({ 'a-good.txt': 'needle here\n', 'z-hostile.txt': `${'a'.repeat(60)}!\n` })
    const text = await run(hostile, 'search_files', { query: '(needle|(a+)+$)', regex: true })
    expect(text).toContain('a-good.txt:1')
    expect(text).toMatch(/regex/i)
  }, 20_000)

  it('keeps the matches that came before the expensive line of the same file', async () => {
    const hostile = repo({ 'mixed.txt': `x marks\nxx again\n${'a'.repeat(60)}!\nx after\n` })
    const text = await run(hostile, 'search_files', { query: '^(x|(a+)+$)', regex: true })
    expect(text).toContain('mixed.txt:1')
    expect(text).toContain('mixed.txt:2')
    expect(text).not.toContain('mixed.txt:4')
    expect(text).toMatch(/regex took too long/)
  }, 20_000)

  it('reports a slow regex on an explicitly chosen file instead of failing the call', async () => {
    const hostile = repo({ 'only.txt': `${'a'.repeat(60)}!\n` })
    const tool = createFileTools(hostile).find((item) => item.definition.name === 'search_files')!
    const result = await tool.execute({ query: '(a+)+$', regex: true, path: 'only.txt' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toMatch(/regex took too long/)
  }, 20_000)

  it('applies the line limit to regex matches and lets $ match before a CRLF line end', async () => {
    const crlf = repo({ 'crlf.txt': 'one foo\r\ntwo foo\r\nthree foo\r\n' })
    const text = await run(crlf, 'search_files', { query: 'foo$', regex: true, limit: 2 })
    expect(text).toContain('crlf.txt:1')
    expect(text).toContain('crlf.txt:2')
    expect(text).not.toContain('crlf.txt:3')
    expect(text).toMatch(/more than 2 lines matched/)
  })
})

describe('large repositories', () => {
  it('spends the search file cap on files it can search, not on images and other binaries', async () => {
    const files: Record<string, string> = { 'deep/inside/target.ts': 'the needle\n' }
    for (let i = 0; i < 2_100; i++) files[`img${i}.png`] = ''
    const text = await run(repo(files), 'search_files', { query: 'needle' })
    expect(text).toContain('deep/inside/target.ts:1')
    expect(text).not.toMatch(/truncated/i)
  })

  it('searches the source types that real projects use, not only web languages', async () => {
    const root = repo({ 'Program.cs': 'needle\n', 'App.vue': 'needle\n', 'tool.mjs': 'needle\n', 'setup.ps1': 'needle\n', 'photo.png': 'needle\n' })
    const text = await run(root, 'search_files', { query: 'needle' })
    for (const name of ['Program.cs', 'App.vue', 'tool.mjs', 'setup.ps1']) expect(text).toContain(`${name}:1`)
    expect(text).not.toContain('photo.png')
  })

  it('stops reading a folder with an enormous number of entries and says the listing is incomplete', async () => {
    const root = repo({ 'huge/placeholder.txt': '' })
    let visited = 0
    let closed = false
    const directory = {
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index < 30_000; index++) {
            visited++
            yield { name: `e${String(index).padStart(5, '0')}.txt`, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true }
          }
        } finally { closed = true }
      }
    }
    const spy = vi.spyOn(fs, 'opendir').mockResolvedValueOnce(directory as unknown as Awaited<ReturnType<typeof fs.opendir>>)
    try {
      const text = await run(root, 'list_files', { path: 'huge' })
      expect(lines(text).filter((line) => line.endsWith('.txt'))).toHaveLength(500)
      expect(text).toMatch(/more than 20000 entries/)
      expect(text).toMatch(/incomplete/i)
      expect(visited).toBeLessThan(30_000)
      expect(closed).toBe(true)
    } finally { spy.mockRestore() }
  })

  it('distinguishes an empty folder from one whose entries are all ignored', async () => {
    const root = repo({ '.gitignore': '*.log\n', 'logs/a.log': '', 'logs/b.log': '' })
    mkdirSync(join(root, 'empty'))
    expect(await run(root, 'list_files', { path: 'empty' })).toBe('(empty)')
    const text = await run(root, 'list_files', { path: 'logs' })
    expect(text).toMatch(/^\(no entries to show\)/)
    expect(text).toMatch(/2 entries hidden by \.gitignore/)
  })

  it('counts a single hidden entry in the singular', async () => {
    const root = repo({ '.gitignore': '*.log\n', 'a.ts': '', 'a.log': '' })
    expect(await run(root, 'list_files', { path: '.' })).toMatch(/1 entry hidden by \.gitignore/)
  })
})
