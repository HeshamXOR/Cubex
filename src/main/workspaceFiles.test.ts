import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, relative } from 'node:path'
import { readWorkspaceDirectory, resolveWorkspacePath, searchWorkspaceEntries, selectWorkspace } from './workspaceFiles'

let dir: string
let projectA: string
let projectB: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cubex-workspace-ui-'))
  projectA = join(dir, 'project')
  projectB = join(dir, 'project-other')
  mkdirSync(projectA)
  mkdirSync(projectB)
  mkdirSync(join(projectA, 'src'))
  writeFileSync(join(projectA, 'alpha.ts'), 'task A')
  writeFileSync(join(projectA, 'z-alpha.ts'), 'task A')
  writeFileSync(join(projectA, 'src', 'alpha-child.ts'), 'task A')
  writeFileSync(join(projectB, 'other-task.txt'), 'task B')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('workspace UI task ownership', () => {
  it('lists and searches the stored task root even when another project is globally selected', async () => {
    const tasks: Record<string, { workspacePath?: string }> = { a: { workspacePath: projectA }, b: { workspacePath: projectB } }
    const taskRoot = selectWorkspace(projectB, 'a', (id) => tasks[id])
    expect((await readWorkspaceDirectory(taskRoot)).map((entry) => entry.name)).toEqual(['src', 'alpha.ts', 'z-alpha.ts'])
    expect((await searchWorkspaceEntries(taskRoot, 'alpha')).map((entry) => entry.path)).toEqual(['alpha.ts', 'src/alpha-child.ts', 'z-alpha.ts'])
    expect(await searchWorkspaceEntries(taskRoot, 'other-task')).toEqual([])
    expect(resolveWorkspacePath(taskRoot, 'alpha.ts')).toBe(realpathSync.native(join(projectA, 'alpha.ts')))
    expect(selectWorkspace(projectB, undefined, () => null)).toBe(projectB)
  })

  it('never falls back for a workspace-less or missing task', async () => {
    const taskRoot = selectWorkspace(projectB, 'no-project', () => ({}))
    expect(taskRoot).toBeUndefined()
    expect(await searchWorkspaceEntries(taskRoot, '')).toEqual([])
    await expect(readWorkspaceDirectory(taskRoot)).rejects.toThrow('No workspace')
    expect(() => resolveWorkspacePath(taskRoot, '.')).toThrow('No workspace')
    expect(() => selectWorkspace(projectB, 'missing', () => null)).toThrow('Task was not found')
    expect(() => selectWorkspace(projectB, '', () => null)).toThrow('Invalid task id')
  })
})

describe('workspace UI containment and discovery', () => {
  it('rejects sibling-prefix paths, absolute escapes and junction escapes', async () => {
    const link = join(projectA, 'outside')
    symlinkSync(projectB, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveWorkspacePath(projectA, '../project-other/other-task.txt')).toThrow('escapes')
    expect(() => resolveWorkspacePath(projectA, join(projectB, 'other-task.txt'))).toThrow('escapes')
    expect(() => resolveWorkspacePath(projectA, 'outside/other-task.txt')).toThrow('escapes')
    await expect(readWorkspaceDirectory(projectA, 'outside')).rejects.toThrow('escapes')
  })

  it('omits internal and external links, hidden entries and generated directories', async () => {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(projectB, join(projectA, 'external-link'), linkType)
    symlinkSync(join(projectA, 'src'), join(projectA, 'internal-link'), linkType)
    mkdirSync(join(projectA, 'node_modules'))
    writeFileSync(join(projectA, 'node_modules', 'ignored.ts'), 'generated')
    writeFileSync(join(projectA, '.hidden'), 'hidden')
    expect((await readWorkspaceDirectory(projectA)).map((entry) => entry.name)).toEqual(['src', 'alpha.ts', 'z-alpha.ts'])
    const all = await searchWorkspaceEntries(projectA, '')
    expect(all.map((entry) => entry.path).sort()).toEqual(['alpha.ts', 'src/alpha-child.ts', 'z-alpha.ts'])
    expect(all.every((entry) => !entry.isDirectory)).toBe(true)
    expect(await readWorkspaceDirectory(projectA, 'src')).toEqual([{ name: 'alpha-child.ts', path: 'src/alpha-child.ts', isDirectory: false }])
  })

  it('accepts a filesystem root and normalized Windows casing without a prefix false positive', () => {
    const realProject = realpathSync.native(projectA)
    const volumeRoot = parse(realProject).root
    expect(resolveWorkspacePath(volumeRoot, relative(volumeRoot, realProject))).toBe(realProject)
    expect(resolveWorkspacePath(projectA, '.')).toBe(realProject)
    if (process.platform === 'win32') {
      expect(resolveWorkspacePath(projectA.toUpperCase(), 'ALPHA.TS')).toBe(realpathSync.native(join(projectA, 'alpha.ts')))
    }
  })

  it('bounds autocomplete requests and rejects malformed UI paths', async () => {
    expect(await searchWorkspaceEntries(projectA, 'ALPHA', 1)).toHaveLength(1)
    await expect(searchWorkspaceEntries(projectA, '', 0)).rejects.toThrow('Search limit')
    await expect(searchWorkspaceEntries(projectA, '', 201)).rejects.toThrow('Search limit')
    await expect(searchWorkspaceEntries(projectA, '', NaN)).rejects.toThrow('Search limit')
    await expect(searchWorkspaceEntries(projectA, 'x'.repeat(4097))).rejects.toThrow('query')
    expect(() => resolveWorkspacePath(projectA, 'bad\0path')).toThrow('Invalid workspace path')
  })
})
