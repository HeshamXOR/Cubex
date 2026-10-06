import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIR_LISTING_MAX_ENTRIES, FILE_PREVIEW_MAX_BYTES, IMAGE_PREVIEW_MAX_BYTES, STAT_PATHS_MAX } from '@shared/workspaceFile'
import { findWorkspaceFiles, listWorkspaceDir, parseBrowseOptions, parseReadOptions, readWorkspaceFile, statWorkspacePaths } from './workspaceRead'

let dir: string
let project: string
let outside: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cubex-files-tab-'))
  project = join(dir, 'project')
  outside = join(dir, 'project-other')
  mkdirSync(project)
  mkdirSync(outside)
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'not yours')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

describe('readWorkspaceFile text', () => {
  it('keeps CRLF in the content and counts lines the way an editor does', async () => {
    writeFileSync(join(project, 'win.txt'), 'one\r\ntwo\r\n\r\nfour\r\n')
    const file = await readWorkspaceFile(project, 'win.txt')
    expect(file).toMatchObject({ kind: 'text', path: 'win.txt', name: 'win.txt', content: 'one\r\ntwo\r\n\r\nfour\r\n', lineCount: 4, lineEnding: 'crlf', truncated: false, encoding: 'utf-8', bom: false })
  })

  it('reports mixed endings and files without a final line break', async () => {
    writeFileSync(join(project, 'mixed.txt'), 'a\r\nb\nc')
    expect(await readWorkspaceFile(project, 'mixed.txt')).toMatchObject({ lineEnding: 'mixed', lineCount: 3 })
  })

  it('returns an empty file as text with no lines', async () => {
    writeFileSync(join(project, 'empty.txt'), '')
    expect(await readWorkspaceFile(project, 'empty.txt')).toMatchObject({ kind: 'text', content: '', lineCount: 0, size: 0, truncated: false })
  })

  it('strips a UTF-8 byte-order mark and says it was there', async () => {
    writeFileSync(join(project, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\n')]))
    const file = await readWorkspaceFile(project, 'bom.txt')
    expect(file).toMatchObject({ kind: 'text', content: 'héllo\n', bom: true, encoding: 'utf-8' })
  })

  it('decodes UTF-16 files that start with a byte-order mark instead of calling them binary', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\r\nthere\r\n', 'utf16le')])
    writeFileSync(join(project, 'le.txt'), le)
    expect(await readWorkspaceFile(project, 'le.txt')).toMatchObject({ kind: 'text', content: 'hi\r\nthere\r\n', encoding: 'utf-16le', bom: true, lineCount: 2 })
    const be = Buffer.from(le)
    be.swap16()
    be[0] = 0xfe
    be[1] = 0xff
    writeFileSync(join(project, 'be.txt'), be)
    expect(await readWorkspaceFile(project, 'be.txt')).toMatchObject({ kind: 'text', content: 'hi\r\nthere\r\n', encoding: 'utf-16be' })
  })

  it('cuts a long file at its last whole line and says it was truncated', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
    writeFileSync(join(project, 'long.txt'), lines.join('\n') + '\n')
    const file = await readWorkspaceFile(project, 'long.txt', { maxBytes: 4096 })
    if (file.kind !== 'text') throw new Error('expected text')
    expect(file.truncated).toBe(true)
    expect(file.size).toBeGreaterThan(4096)
    expect(file.content.endsWith('\n')).toBe(true)
    expect(file.content.length).toBeLessThanOrEqual(4096)
    expect(file.lineCount).toBe(file.content.split('\n').length - 1)
    expect(file.content.split('\n')[file.lineCount - 1]).toBe(`line ${file.lineCount}`)
  })

  it('never shows half of a multi-byte character where a line without breaks is cut', async () => {
    writeFileSync(join(project, 'one-line.txt'), 'é'.repeat(3000))
    const file = await readWorkspaceFile(project, 'one-line.txt', { maxBytes: 2049 })
    if (file.kind !== 'text') throw new Error('expected text')
    expect(file.truncated).toBe(true)
    expect(file.content).not.toContain('�')
    expect(file.content).toBe('é'.repeat(1024))
  })

  it('keeps the whole chunk when the only line break is early in a long minified line', async () => {
    writeFileSync(join(project, 'min.js'), `// header\n${'x'.repeat(5000)}`)
    const file = await readWorkspaceFile(project, 'min.js', { maxBytes: 2048 })
    if (file.kind !== 'text') throw new Error('expected text')
    expect(file.truncated).toBe(true)
    expect(file.content.length).toBe(2048)
  })

  it('caps what a caller may ask for', () => {
    expect(parseReadOptions({ maxBytes: 1e12 })).toEqual({ maxBytes: FILE_PREVIEW_MAX_BYTES })
    expect(parseReadOptions({ maxBytes: 3 })).toEqual({ maxBytes: 1024 })
    expect(parseReadOptions({ maxBytes: 'lots' })).toEqual({})
    expect(parseReadOptions(undefined)).toEqual({})
    expect(parseReadOptions(null)).toEqual({})
    expect(parseReadOptions({ maxBytes: Infinity })).toEqual({})
  })
})

describe('readWorkspaceFile binary and images', () => {
  it('reports a file with NUL bytes as binary with its size', async () => {
    writeFileSync(join(project, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0, 0, 1, 2, 3]))
    expect(await readWorkspaceFile(project, 'tool.exe')).toMatchObject({ kind: 'binary', size: 7, name: 'tool.exe' })
  })

  it('reports a file that is mostly control characters as binary', async () => {
    writeFileSync(join(project, 'blob.dat'), Buffer.from(Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? 65 : 2))))
    expect((await readWorkspaceFile(project, 'blob.dat')).kind).toBe('binary')
  })

  it('keeps terminal escape codes readable as text', async () => {
    writeFileSync(join(project, 'run.log'), '\u001b[32mok\u001b[0m\nnext\n')
    expect((await readWorkspaceFile(project, 'run.log')).kind).toBe('text')
  })

  it('returns an image as a bounded data URL', async () => {
    writeFileSync(join(project, 'logo.png'), PNG_HEAD)
    const file = await readWorkspaceFile(project, 'logo.png')
    expect(file).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG_HEAD.length })
    expect(file.kind === 'image' && file.dataUrl).toBe(`data:image/png;base64,${PNG_HEAD.toString('base64')}`)
  })

  it('recognises an image by its bytes, not its name', async () => {
    writeFileSync(join(project, 'photo.dat'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]))
    expect(await readWorkspaceFile(project, 'photo.dat')).toMatchObject({ kind: 'image', mime: 'image/jpeg' })
  })

  it('does not call text that happens to start with BM a bitmap', async () => {
    writeFileSync(join(project, 'notes.txt'), 'BM25 is a ranking function\n')
    expect((await readWorkspaceFile(project, 'notes.txt')).kind).toBe('text')
  })

  it('describes an image over the preview limit without sending it', async () => {
    const big = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1)
    PNG_HEAD.copy(big)
    writeFileSync(join(project, 'huge.png'), big)
    expect(await readWorkspaceFile(project, 'huge.png')).toMatchObject({ kind: 'image', dataUrl: null, size: big.length })
  })

  it('serves an SVG as text so the viewer can show its source', async () => {
    writeFileSync(join(project, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
    expect((await readWorkspaceFile(project, 'mark.svg')).kind).toBe('text')
  })
})

describe('readWorkspaceFile containment and errors', () => {
  it('refuses traversal, absolute paths outside the workspace and sibling-prefix folders', async () => {
    await expect(readWorkspaceFile(project, '../project-other/secret.txt')).rejects.toThrow('escapes')
    await expect(readWorkspaceFile(project, join(outside, 'secret.txt'))).rejects.toThrow('escapes')
    await expect(readWorkspaceFile(project, '..\\project-other\\secret.txt')).rejects.toThrow()
  })

  it('refuses a junction or symlink that leaves the workspace', async () => {
    symlinkSync(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readWorkspaceFile(project, 'link/secret.txt')).rejects.toThrow('escapes')
  })

  it('refuses a file symlink to an outside file when the OS allows creating one', async () => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(project, 'peek.txt'), 'file')
    } catch {
      return
    }
    await expect(readWorkspaceFile(project, 'peek.txt')).rejects.toThrow('escapes')
  })

  it('says what is wrong with a missing file or a folder, without absolute paths', async () => {
    const missing = await readWorkspaceFile(project, 'src/nope.ts').catch((error: Error) => error)
    expect(missing).toBeInstanceOf(Error)
    expect((missing as Error).message).toBe('src/nope.ts was not found in the workspace. It may have been moved or deleted.')
    expect((missing as Error).message).not.toContain(dir)
    await expect(readWorkspaceFile(project, 'src')).rejects.toThrow('is a folder')
    await expect(readWorkspaceFile(project, '.')).rejects.toThrow('is a folder')
  })

  it('rejects malformed requests and a task with no workspace', async () => {
    await expect(readWorkspaceFile(project, '')).rejects.toThrow('Choose a file')
    await expect(readWorkspaceFile(project, 42)).rejects.toThrow('Choose a file')
    await expect(readWorkspaceFile(project, 'bad\0name')).rejects.toThrow('Invalid workspace path')
    await expect(readWorkspaceFile(project, 'x'.repeat(5000))).rejects.toThrow('Invalid workspace path')
    await expect(readWorkspaceFile(undefined, 'src/a.ts')).rejects.toThrow('No workspace')
  })

  it('reads a file the user has open with different casing on Windows', async () => {
    if (process.platform !== 'win32') return
    expect(await readWorkspaceFile(project, 'SRC/A.TS')).toMatchObject({ kind: 'text', path: 'src/a.ts' })
  })
})

describe('statWorkspacePaths', () => {
  it('finds files and folders and returns the canonical path to open', async () => {
    expect(await statWorkspacePaths(project, ['src/a.ts', 'src', './src/a.ts', 'src\\a.ts'])).toEqual([
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'directory', path: 'src' },
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'file', path: 'src/a.ts' }
    ])
  })

  it('maps an absolute path inside the workspace to its relative form', async () => {
    expect(await statWorkspacePaths(project, [join(project, 'src', 'a.ts')])).toEqual([{ kind: 'file', path: 'src/a.ts' }])
  })

  it('answers missing for absent paths, escapes, the root itself and junk', async () => {
    const answers = await statWorkspacePaths(project, ['nope.ts', '../project-other/secret.txt', join(outside, 'secret.txt'), '.', '', '   ', 5, null, 'a\0b', 'x'.repeat(2000)])
    expect(answers.every((answer) => answer.kind === 'missing')).toBe(true)
    expect(answers).toHaveLength(10)
  })

  it('does not follow a junction out of the workspace', async () => {
    symlinkSync(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await statWorkspacePaths(project, ['link/secret.txt', 'link'])).toEqual([{ kind: 'missing' }, { kind: 'missing' }])
  })

  it('answers missing for everything when the task has no workspace, and bounds the request', async () => {
    expect(await statWorkspacePaths(undefined, ['a.ts'])).toEqual([{ kind: 'missing' }])
    await expect(statWorkspacePaths(project, Array.from({ length: STAT_PATHS_MAX + 1 }, () => 'a'))).rejects.toThrow('at most')
    await expect(statWorkspacePaths(project, 'src/a.ts')).rejects.toThrow('at most')
  })
})

describe('listWorkspaceDir and findWorkspaceFiles', () => {
  beforeEach(() => {
    mkdirSync(join(project, 'node_modules'))
    writeFileSync(join(project, 'node_modules', 'dep.js'), 'x')
    writeFileSync(join(project, '.env.example'), 'KEY=')
    mkdirSync(join(project, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(project, '.github', 'workflows', 'ci.yml'), 'name: ci')
    writeFileSync(join(project, 'README.md'), '# hi')
  })

  it('lists the usual noise out by default', async () => {
    const listing = await listWorkspaceDir(project, '.')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['src', 'README.md'])
    expect(listing.omitted).toBe(0)
  })

  it('adds hidden and ignored entries, marked as such, when asked', async () => {
    const listing = await listWorkspaceDir(project, '.', { showHidden: true })
    expect(listing.entries.map((entry) => entry.name)).toEqual(['.github', 'node_modules', 'src', '.env.example', 'README.md'])
    expect(listing.entries.filter((entry) => entry.hidden).map((entry) => entry.name)).toEqual(['.github', 'node_modules', '.env.example'])
  })

  it('opens a hidden folder only when hidden entries are shown too', async () => {
    expect((await listWorkspaceDir(project, '.github/workflows', { showHidden: true })).entries.map((entry) => entry.path)).toEqual(['.github/workflows/ci.yml'])
  })

  it('caps a huge folder and counts what it left out', async () => {
    mkdirSync(join(project, 'big'))
    for (let i = 0; i < DIR_LISTING_MAX_ENTRIES + 25; i++) writeFileSync(join(project, 'big', `f${String(i).padStart(5, '0')}.txt`), '')
    const listing = await listWorkspaceDir(project, 'big')
    expect(listing.entries).toHaveLength(DIR_LISTING_MAX_ENTRIES)
    expect(listing.omitted).toBe(25)
  })

  it('refuses to list outside the workspace and says a missing folder is missing', async () => {
    await expect(listWorkspaceDir(project, '../project-other')).rejects.toThrow('escapes')
    await expect(listWorkspaceDir(project, 'nope')).rejects.toThrow('was not found')
    await expect(listWorkspaceDir(project, 7)).rejects.toThrow('Invalid workspace path')
  })

  it('finds dot-files when hidden entries are shown, but never searches inside ignored folders', async () => {
    expect((await findWorkspaceFiles(project, 'ci', 20, {})).map((entry) => entry.path)).toEqual([])
    const found = await findWorkspaceFiles(project, 'ci', 20, parseBrowseOptions({ showHidden: true }))
    expect(found.map((entry) => entry.path)).toEqual(['.github/workflows/ci.yml'])
    expect(found[0]?.hidden).toBe(true)
    expect((await findWorkspaceFiles(project, 'dep', 20, { showHidden: true })).map((entry) => entry.path)).toEqual([])
  })

  it('validates the search request', async () => {
    await expect(findWorkspaceFiles(project, 4, 10)).rejects.toThrow('Invalid workspace search query')
    await expect(findWorkspaceFiles(project, 'a', 'ten')).rejects.toThrow('must be a number')
    await expect(findWorkspaceFiles(project, 'a', 0)).rejects.toThrow('Search limit')
  })

  it('reads the browse option only when it is exactly true', () => {
    expect(parseBrowseOptions({ showHidden: true })).toEqual({ showHidden: true })
    expect(parseBrowseOptions({ showHidden: 'yes' })).toEqual({ showHidden: false })
    expect(parseBrowseOptions(undefined)).toEqual({ showHidden: false })
    expect(parseBrowseOptions(null)).toEqual({ showHidden: false })
  })
})
