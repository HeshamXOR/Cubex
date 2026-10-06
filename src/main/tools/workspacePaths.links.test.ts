import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Link handling of the path guard, simulated so it runs everywhere: creating real file
 * symlinks needs privileges on Windows, and a junction whose target is gone cannot be
 * cleaned up. `links` maps a path to its target; null means a link whose target is missing.
 */
const mocks = vi.hoisted(() => ({ links: new Map<string, string | null>() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const lstatSync = ((path: string, options?: never) => {
    if (mocks.links.has(String(path))) return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
    return actual.lstatSync(path, options)
  }) as unknown as typeof actual.lstatSync
  const resolveLink = (path: string): string => {
    const target = mocks.links.get(String(path))
    if (target === null) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    return target ?? actual.realpathSync.native(path)
  }
  return { ...actual, lstatSync, realpathSync: Object.assign((path: string) => resolveLink(path), { native: resolveLink }) }
})

import { safeResolve } from './workspacePaths'

const base = mkdtempSync(join(tmpdir(), 'cubex-links-'))
const root = join(base, 'ws')
const outside = join(base, 'elsewhere')
mkdirSync(root)
mkdirSync(outside)
const realRoot = realpathSync.native(root)
beforeEach(() => mocks.links.clear())
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('links on the way to a path', () => {
  it('rejects a link whose target is missing, as the path or as a middle component', () => {
    mocks.links.set(join(root, 'dangling'), null)
    expect(() => safeResolve(root, 'dangling')).toThrow(/symbolic link whose target does not exist/)
    expect(() => safeResolve(root, 'dangling/new.txt')).toThrow(/symbolic link whose target does not exist/)
    expect(() => safeResolve(root, 'dangling/deep/er/new.txt', { mutating: true })).toThrow(/symbolic link whose target does not exist/)
  })

  it('rejects a link to a file or folder outside the workspace', () => {
    mocks.links.set(join(root, 'file-link'), join(outside, 'secret.txt'))
    mocks.links.set(join(root, 'dir-link'), outside)
    expect(() => safeResolve(root, 'file-link')).toThrow(/escapes the workspace/)
    expect(() => safeResolve(root, 'dir-link/secret.txt')).toThrow(/escapes the workspace/)
    expect(() => safeResolve(root, 'dir-link/new.txt', { mutating: true })).toThrow(/escapes the workspace/)
  })

  it('allows a link that stays inside the workspace', () => {
    mocks.links.set(join(root, 'inner'), join(realRoot, 'real-dir'))
    expect(safeResolve(root, 'inner/file.txt')).toBe(join(root, 'inner', 'file.txt'))
    expect(safeResolve(root, 'inner/file.txt', { mutating: true })).toBe(join(root, 'inner', 'file.txt'))
  })

  it('refuses to change a protected folder through a link, but still allows reading through it', () => {
    mocks.links.set(join(root, 'innocent'), join(realRoot, '.git'))
    expect(() => safeResolve(root, 'innocent/hooks/pre-commit', { mutating: true })).toThrow(/protected folder/)
    expect(() => safeResolve(root, 'innocent', { mutating: true })).toThrow(/protected folder/)
    expect(safeResolve(root, 'innocent/hooks/pre-commit')).toBe(join(root, 'innocent', 'hooks', 'pre-commit'))
  })

  it('leaves a path that is already spelled as a protected folder to the approval rule', () => {
    expect(safeResolve(root, '.git/hooks/pre-commit', { mutating: true })).toBe(join(root, '.git', 'hooks', 'pre-commit'))
    mocks.links.set(join(root, 'a'), join(realRoot, '.claude'))
    expect(safeResolve(root, '.claude/settings.json', { mutating: true })).toBe(join(root, '.claude', 'settings.json'))
  })

  it('does not treat a link to a sibling folder as a spelling alias', () => {
    mocks.links.set(join(root, 'latest'), join(realRoot, 'v2'))
    expect(safeResolve(root, 'latest/readme.md')).toBe(join(root, 'latest', 'readme.md'))
  })
})
