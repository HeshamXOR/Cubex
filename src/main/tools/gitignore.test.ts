import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitIgnore } from './gitignore'

const base = mkdtempSync(join(tmpdir(), 'cubex-ignore-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let counter = 0

/** A workspace with the given files, and a matcher that has loaded the rules governing `dir`. */
async function matcher(files: Record<string, string>, dir = '', options?: { caseInsensitive?: boolean }): Promise<GitIgnore> {
  const root = join(base, `repo${counter++}`)
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const ignore = new GitIgnore(root, { caseInsensitive: false, ...options })
  await ignore.load(dir)
  return ignore
}

describe('gitignore patterns', () => {
  it('ignores by basename at any depth, and treats comments and blank lines as nothing', async () => {
    const ignore = await matcher({ '.gitignore': '# comment\n\n*.log\nsecret.txt\n' })
    expect(ignore.ignores('debug.log', false)).toBe(true)
    expect(ignore.ignores('a/b/trace.log', false)).toBe(true)
    expect(ignore.ignores('secret.txt', false)).toBe(true)
    expect(ignore.ignores('deep/er/secret.txt', false)).toBe(true)
    expect(ignore.ignores('notes.txt', false)).toBe(false)
    expect(ignore.ignores('# comment', false)).toBe(false)
  })

  it('matches directory-only patterns only against directories', async () => {
    const ignore = await matcher({ '.gitignore': 'build/\n' })
    expect(ignore.ignores('build', true)).toBe(true)
    expect(ignore.ignores('pkg/build', true)).toBe(true)
    expect(ignore.ignores('build', false)).toBe(false)
  })

  it('anchors a pattern that starts with or contains a slash', async () => {
    const ignore = await matcher({ '.gitignore': '/dist\ndocs/*.md\nsrc/gen/\n' })
    expect(ignore.ignores('dist', true)).toBe(true)
    expect(ignore.ignores('pkg/dist', true)).toBe(false)
    expect(ignore.ignores('docs/readme.md', false)).toBe(true)
    expect(ignore.ignores('docs/deep/readme.md', false)).toBe(false)
    expect(ignore.ignores('other/docs/readme.md', false)).toBe(false)
    expect(ignore.ignores('src/gen', true)).toBe(true)
    expect(ignore.ignores('lib/src/gen', true)).toBe(false)
  })

  it('supports ?, character classes and escaped specials', async () => {
    const ignore = await matcher({ '.gitignore': '?.js\n[a-c].txt\n[!x]y.md\n\\#hash\n\\!bang\nstar\\*.c\n' })
    expect(ignore.ignores('a.js', false)).toBe(true)
    expect(ignore.ignores('ab.js', false)).toBe(false)
    expect(ignore.ignores('b.txt', false)).toBe(true)
    expect(ignore.ignores('d.txt', false)).toBe(false)
    expect(ignore.ignores('zy.md', false)).toBe(true)
    expect(ignore.ignores('xy.md', false)).toBe(false)
    expect(ignore.ignores('#hash', false)).toBe(true)
    expect(ignore.ignores('!bang', false)).toBe(true)
    expect(ignore.ignores('star*.c', false)).toBe(true)
    expect(ignore.ignores('starx.c', false)).toBe(false)
  })

  it('handles double stars: leading, middle and trailing', async () => {
    const ignore = await matcher({ '.gitignore': '**/temp\na/**/z.txt\nout/**\n' })
    expect(ignore.ignores('temp', true)).toBe(true)
    expect(ignore.ignores('x/y/temp', true)).toBe(true)
    expect(ignore.ignores('a/z.txt', false)).toBe(true)
    expect(ignore.ignores('a/b/c/z.txt', false)).toBe(true)
    expect(ignore.ignores('b/z.txt', false)).toBe(false)
    // "out/**" ignores what is inside out, not out itself.
    expect(ignore.ignores('out/file.js', false)).toBe(true)
    expect(ignore.ignores('out/deep/file.js', false)).toBe(true)
    expect(ignore.ignores('out', true)).toBe(false)
  })

  it('lets a later negation re-include, and ignores trailing spaces unless escaped', async () => {
    const ignore = await matcher({ '.gitignore': '*.log\n!keep.log\ntrailing   \nescaped\\ \n' })
    expect(ignore.ignores('a.log', false)).toBe(true)
    expect(ignore.ignores('keep.log', false)).toBe(false)
    expect(ignore.ignores('trailing', false)).toBe(true)
    expect(ignore.ignores('trailing   ', false)).toBe(false)
    expect(ignore.ignores('escaped ', false)).toBe(true)
  })

  it('applies CRLF files and a missing final newline', async () => {
    const ignore = await matcher({ '.gitignore': '*.tmp\r\nbuild/\r\nlast' })
    expect(ignore.ignores('a.tmp', false)).toBe(true)
    expect(ignore.ignores('build', true)).toBe(true)
    expect(ignore.ignores('last', false)).toBe(true)
  })

  it('treats an unclosed bracket as literal text', async () => {
    const ignore = await matcher({ '.gitignore': 'weird[name\n' })
    expect(ignore.ignores('weird[name', false)).toBe(true)
    expect(ignore.ignores('weirdx', false)).toBe(false)
  })

  it('can match case-insensitively, as git does on Windows', async () => {
    const insensitive = await matcher({ '.gitignore': 'Build/\n*.LOG\n' }, '', { caseInsensitive: true })
    expect(insensitive.ignores('build', true)).toBe(true)
    expect(insensitive.ignores('a.log', false)).toBe(true)
    const sensitive = await matcher({ '.gitignore': 'Build/\n*.LOG\n' }, '', { caseInsensitive: false })
    expect(sensitive.ignores('build', true)).toBe(false)
    expect(sensitive.ignores('a.LOG', false)).toBe(true)
  })
})

describe('nested ignore files and precedence', () => {
  it('lets a deeper file override a shallower one, only inside its own folder', async () => {
    const ignore = await matcher({ '.gitignore': '*.txt\n', 'sub/.gitignore': '!keep.txt\n*.md\n', 'sub/keep.txt': '', 'other/keep.txt': '' }, 'sub')
    expect(ignore.ignores('sub/keep.txt', false)).toBe(false)
    expect(ignore.ignores('sub/other.txt', false)).toBe(true)
    expect(ignore.ignores('sub/doc.md', false)).toBe(true)
    await ignore.load('other')
    expect(ignore.ignores('other/keep.txt', false)).toBe(true)
    expect(ignore.ignores('other/doc.md', false)).toBe(false)
  })

  it('anchors a nested pattern to the folder that holds its ignore file', async () => {
    const ignore = await matcher({ 'pkg/.gitignore': '/generated\nlocal/*.json\n' }, 'pkg')
    expect(ignore.ignores('pkg/generated', true)).toBe(true)
    expect(ignore.ignores('pkg/sub/generated', true)).toBe(false)
    expect(ignore.ignores('pkg/local/a.json', false)).toBe(true)
    expect(ignore.ignores('generated', true)).toBe(false)
  })

  it('reads .git/info/exclude with lower priority than .gitignore', async () => {
    const ignore = await matcher({ '.git/info/exclude': 'private/\n*.bak\n', '.gitignore': '!keep.bak\n' })
    expect(ignore.ignores('private', true)).toBe(true)
    expect(ignore.ignores('x.bak', false)).toBe(true)
    expect(ignore.ignores('keep.bak', false)).toBe(false)
  })

  it('loads each ancestor when asked about a deep folder', async () => {
    const ignore = await matcher({ '.gitignore': 'root-only\n', 'a/.gitignore': 'in-a\n', 'a/b/.gitignore': 'in-b\n' }, 'a/b')
    expect(ignore.ignores('a/b/root-only', false)).toBe(true)
    expect(ignore.ignores('a/b/in-a', false)).toBe(true)
    expect(ignore.ignores('a/b/in-b', false)).toBe(true)
    expect(ignore.ignores('a/b/other', false)).toBe(false)
  })

  it('uses no rules for a folder without an ignore file, and trusts a hint that there is none', async () => {
    const ignore = await matcher({ 'a/file.txt': '' }, 'a')
    expect(ignore.ignores('a/file.txt', false)).toBe(false)
    await ignore.load('a', false)
    expect(ignore.ignores('a/file.txt', false)).toBe(false)
  })
})

describe('untrusted ignore files', () => {
  it('stays fast on patterns built to backtrack badly', async () => {
    const hostile = `${'*a'.repeat(30)}*b\n${'[a-z]*'.repeat(25)}x\n`
    const ignore = await matcher({ '.gitignore': hostile })
    const name = 'a'.repeat(200)
    const start = Date.now()
    for (let i = 0; i < 200; i++) ignore.ignores(`dir/${name}`, false)
    expect(Date.now() - start).toBeLessThan(1500)
  })

  it('skips oversized lines, caps the rule count and ignores an oversized file', async () => {
    const ignore = await matcher({ '.gitignore': `${'x'.repeat(5000)}\nreal\n` })
    expect(ignore.ignores('real', false)).toBe(true)
    // Short lines, so the file stays under the size cap and the rule-count cap is what applies.
    const many = await matcher({ '.gitignore': Array.from({ length: 20_000 }, (_, i) => `f${i}`).join('\n') })
    expect(many.ignores('f0', false)).toBe(true)
    expect(many.ignores('f4999', false)).toBe(true)
    expect(many.ignores('f19999', false)).toBe(false)
    const huge = await matcher({ '.gitignore': `${'a\n'.repeat(400_000)}real\n` })
    expect(huge.ignores('real', false)).toBe(false)
  })

  it('does not follow a symlinked ignore file', async (context) => {
    const root = join(base, `repo${counter++}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(base, 'elsewhere.ignore'), '*\n')
    try { symlinkSync(join(base, 'elsewhere.ignore'), join(root, '.gitignore'), 'file') } catch { return context.skip() }
    const ignore = new GitIgnore(root, { caseInsensitive: false })
    await ignore.load('')
    expect(ignore.ignores('anything.txt', false)).toBe(false)
  })
})
