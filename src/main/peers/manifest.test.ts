import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changesBetween, takeManifest } from './manifest'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-manifest-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (path: string, text: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

describe('takeManifest', () => {
  it('lists the files of the folder and the folders inside it, with forward slashes', async () => {
    write('a.txt', 'a')
    write('src/b.ts', 'b')
    write('src/deep/c.ts', 'c')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()].sort()).toEqual(['a.txt', 'src/b.ts', 'src/deep/c.ts'])
    expect(manifest.complete).toBe(true)
  })

  it('always skips git data and node_modules', async () => {
    write('src/a.ts', 'a')
    write('node_modules/x/index.js', 'x')
    write('.git/config', 'g')
    write('packages/p/node_modules/y.js', 'y')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()]).toEqual(['src/a.ts'])
  })

  it('lists a small build folder when there is no git repository', async () => {
    write('src/a.ts', 'a')
    write('dist/out.js', 'o')
    write('release/app.exe', 'r')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()].sort()).toEqual(['dist/out.js', 'release/app.exe', 'src/a.ts'])
  })

  it('skips a large build folder when there is no git repository', async () => {
    write('src/a.ts', 'a')
    for (let index = 0; index < 8; index++) write(`build/deep/f${index}.js`, 'x')
    write('out/small.js', 's')
    const manifest = await takeManifest(root, { largeFolderFiles: 5 })
    expect([...manifest.files.keys()].sort()).toEqual(['out/small.js', 'src/a.ts'])
  })

  it('skips the build folders git ignores, and lists the ones it does not', async () => {
    write('.git/config', 'g')
    write('.gitignore', ['dist/', 'coverage', ''].join(String.fromCharCode(10)))
    write('src/a.ts', 'a')
    write('dist/out.js', 'o')
    write('coverage/lcov.info', 'c')
    write('release/app.exe', 'r')
    write('build/tracked.txt', 't')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()].sort()).toEqual(['.gitignore', 'build/tracked.txt', 'release/app.exe', 'src/a.ts'])
  })

  it('honours a nested .gitignore for a build folder deeper in the project', async () => {
    write('.git/config', 'g')
    write('app/.gitignore', 'out')
    write('app/out/bundle.js', 'b')
    write('app/src/a.ts', 'a')
    write('lib/out/kept.js', 'k')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()].sort()).toEqual(['app/.gitignore', 'app/src/a.ts', 'lib/out/kept.js'])
  })

  it('shows a change a delegated agent makes in a tracked build folder', async () => {
    write('.git/config', 'g')
    write('release/notes.txt', 'v1')
    const before = await takeManifest(root)
    write('release/notes.txt', 'version two')
    write('release/new.txt', 'n')
    const after = await takeManifest(root)
    expect(changesBetween(before, after)).toEqual([
      { path: 'release/new.txt', change: 'created' },
      { path: 'release/notes.txt', change: 'edited' }
    ])
  })

  it('keeps other hidden folders, which hold settings an agent may change', async () => {
    write('.claude/settings.json', '{}')
    write('.vscode/tasks.json', '{}')
    const manifest = await takeManifest(root)
    expect([...manifest.files.keys()].sort()).toEqual(['.claude/settings.json', '.vscode/tasks.json'])
  })

  it('says it is incomplete when there are more files than it keeps', async () => {
    for (let index = 0; index < 12; index++) write(`f${index}.txt`, 'x')
    const manifest = await takeManifest(root, { maxFiles: 5 })
    expect(manifest.files.size).toBe(5)
    expect(manifest.complete).toBe(false)
  })

  it('says it is incomplete when it runs out of time', async () => {
    write('a.txt', 'a')
    const manifest = await takeManifest(root, { maxMs: -1 })
    expect(manifest.complete).toBe(false)
  })

  it('does not follow a link out of the folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cubex-manifest-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 's')
      write('a.txt', 'a')
      try { symlinkSync(outside, join(root, 'link'), 'junction') } catch { return }
      const manifest = await takeManifest(root)
      expect([...manifest.files.keys()]).not.toContain('link/secret.txt')
    } finally {
      // The link goes first: a link to a folder that is gone cannot be removed with the folder around it.
      try { unlinkSync(join(root, 'link')) } catch { /* it was never made */ }
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('lists nothing for a folder that is not there', async () => {
    const manifest = await takeManifest(join(root, 'missing'))
    expect(manifest.files.size).toBe(0)
  })
})

describe('changesBetween', () => {
  it('tells an edit, a new file and a removed file apart', async () => {
    write('keep.txt', 'same')
    write('edit.txt', 'one')
    write('gone.txt', 'bye')
    const before = await takeManifest(root)
    write('edit.txt', 'two, longer')
    write('src/new.ts', 'new')
    rmSync(join(root, 'gone.txt'))
    const after = await takeManifest(root)
    expect(changesBetween(before, after)).toEqual([
      { path: 'edit.txt', change: 'edited' },
      { path: 'gone.txt', change: 'deleted' },
      { path: 'src/new.ts', change: 'created' }
    ])
  })

  it('sees an edit that keeps the size, by the modification time', async () => {
    write('a.txt', 'aaaa')
    const before = await takeManifest(root)
    write('a.txt', 'bbbb')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(root, 'a.txt'), later, later)
    const after = await takeManifest(root)
    expect(changesBetween(before, after)).toEqual([{ path: 'a.txt', change: 'edited' }])
  })

  it('reports nothing when nothing changed', async () => {
    write('a.txt', 'a')
    const before = await takeManifest(root)
    const after = await takeManifest(root)
    expect(changesBetween(before, after)).toEqual([])
  })

  it('does not call a file new or gone when a listing was cut short', () => {
    const full = { files: new Map([['a.txt', '1:1'], ['b.txt', '1:1']]), complete: true }
    const cut = { files: new Map([['a.txt', '1:2']]), complete: false }
    expect(changesBetween(full, cut)).toEqual([{ path: 'a.txt', change: 'edited' }])
    expect(changesBetween(cut, full)).toEqual([{ path: 'a.txt', change: 'edited' }])
  })
})
