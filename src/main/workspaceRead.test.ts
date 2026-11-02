import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findWorkspaceFiles, listWorkspaceDir, parseBrowseOptions, readWorkspaceFile, statWorkspacePaths } from './workspaceRead'

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
})

describe('readWorkspaceFile binary and images', () => {
  it('reports a file with NUL bytes as binary with its size', async () => {
    writeFileSync(join(project, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0, 0, 1, 2, 3]))
    expect(await readWorkspaceFile(project, 'tool.exe')).toMatchObject({ kind: 'binary', size: 7, name: 'tool.exe' })
  })

  it('returns an image as a bounded data URL', async () => {
    writeFileSync(join(project, 'logo.png'), PNG_HEAD)
    const file = await readWorkspaceFile(project, 'logo.png')
    expect(file).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG_HEAD.length })
    expect(file.kind === 'image' && file.dataUrl).toBe(`data:image/png;base64,${PNG_HEAD.toString('base64')}`)
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

  it('answers missing for absent paths, escapes, the root itself and junk', async () => {
    const answers = await statWorkspacePaths(project, ['nope.ts', '../project-other/secret.txt', join(outside, 'secret.txt'), '.', '', '   ', 5, null, 'a\0b', 'x'.repeat(2000)])
    expect(answers.every((answer) => answer.kind === 'missing')).toBe(true)
    expect(answers).toHaveLength(10)
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
})
