import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitStatusReader, parseStatusHeader } from './gitStatus'

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0

describe('parseStatusHeader', () => {
  it.each([
    ['## main', { branch: 'main' }],
    ['## main...origin/main', { branch: 'main', ahead: 0, behind: 0 }],
    ['## main...origin/main [ahead 2]', { branch: 'main', ahead: 2, behind: 0 }],
    ['## main...origin/main [behind 3]', { branch: 'main', ahead: 0, behind: 3 }],
    ['## release/1.2...origin/release/1.2 [ahead 1, behind 4]', { branch: 'release/1.2', ahead: 1, behind: 4 }],
    ['## main...origin/main [gone]', { branch: 'main' }],
    ['## HEAD (no branch)', {}],
    ['## No commits yet on trunk', { branch: 'trunk' }],
    ['## Initial commit on master', { branch: 'master' }]
  ])('parses %s', (line, expected) => {
    expect(parseStatusHeader(line)).toEqual(expected)
  })
})

describe.skipIf(!hasGit)('GitStatusReader', () => {
  let root: string

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Cubex Test', '-c', 'user.email=cubex@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args
  ], { cwd, windowsHide: true, encoding: 'utf8' })

  /** A repository on branch "trunk" with one commit of a.txt = "one". */
  const initRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q')
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')
    writeFileSync(join(dir, 'a.txt'), 'one')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'initial')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-git-status-'))
  })

  afterEach(() => {
    // Windows keeps a freshly written .git folder locked for a moment (git itself, antivirus), so removing it can fail with EPERM under load.
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  })

  it('returns null without a workspace and isRepo false for plain or missing folders', async () => {
    const reader = new GitStatusReader()
    expect(await reader.read(undefined)).toBeNull()
    expect(await reader.read(join(root, 'missing'))).toEqual({ isRepo: false, changedFiles: 0 })
    // A temp folder inside someone's home-directory repository is still a repository.
    const insideRepo = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, windowsHide: true }).status === 0
    if (!insideRepo) expect(await reader.read(root)).toEqual({ isRepo: false, changedFiles: 0 })
  })

  it('reports the branch, short head and uncommitted changes including untracked files', async () => {
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'two')
    writeFileSync(join(root, 'new.txt'), 'untracked')
    const head = git(root, 'rev-parse', '--short', 'HEAD').trim()
    expect(await new GitStatusReader().read(root)).toEqual({ isRepo: true, branch: 'trunk', head, changedFiles: 2 })
  })

  it('reports ahead and behind counts against the upstream', async () => {
    const origin = join(root, 'origin')
    const clone = join(root, 'clone')
    initRepo(origin)
    git(root, 'clone', '-q', origin, clone)
    writeFileSync(join(clone, 'local.txt'), 'local')
    git(clone, 'add', 'local.txt')
    git(clone, 'commit', '-q', '-m', 'local')
    writeFileSync(join(origin, 'remote.txt'), 'remote')
    git(origin, 'add', 'remote.txt')
    git(origin, 'commit', '-q', '-m', 'remote')
    git(clone, 'fetch', '-q')
    expect(await new GitStatusReader().read(clone)).toMatchObject({ isRepo: true, branch: 'trunk', ahead: 1, behind: 1, changedFiles: 0 })
  })

  it('reports a detached HEAD without a branch, and an unborn branch without a head', async () => {
    initRepo(root)
    const head = git(root, 'rev-parse', '--short', 'HEAD').trim()
    git(root, 'checkout', '-q', '--detach')
    expect(await new GitStatusReader().read(root)).toEqual({ isRepo: true, head, changedFiles: 0 })

    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    git(fresh, 'init', '-q')
    git(fresh, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')
    writeFileSync(join(fresh, 'new.txt'), 'untracked')
    expect(await new GitStatusReader().read(fresh)).toEqual({ isRepo: true, branch: 'trunk', changedFiles: 1 })
  })

  it('still reports the branch when git status itself fails', async () => {
    initRepo(root)
    const head = git(root, 'rev-parse', '--short', 'HEAD').trim()
    // An unreadable index fails `git status` but not the cheaper branch lookups.
    writeFileSync(join(root, '.git', 'index'), 'not an index')
    expect(await new GitStatusReader().read(root)).toEqual({ isRepo: true, branch: 'trunk', head, changedFiles: 0, changedFilesUnknown: true })
  })

  it('reuses a probe within the cache window', async () => {
    initRepo(root)
    const reader = new GitStatusReader(60_000)
    expect(await reader.read(root)).toMatchObject({ changedFiles: 0 })
    writeFileSync(join(root, 'new.txt'), 'untracked')
    expect(await reader.read(root)).toMatchObject({ changedFiles: 0 })
    expect(await new GitStatusReader().read(root)).toMatchObject({ changedFiles: 1 })
  })

  it('never runs a filter program defined by the repository', async () => {
    initRepo(root)
    const marker = join(root, 'filter-ran')
    git(root, 'config', 'filter.evil.clean', `echo ran > "${marker.replace(/\\/g, '/')}"`)
    writeFileSync(join(root, '.gitattributes'), '* filter=evil\n')
    // Same size, new content: git status must hash the file through its clean filter.
    writeFileSync(join(root, 'a.txt'), 'two')

    expect(await new GitStatusReader().read(root)).toMatchObject({ isRepo: true, branch: 'trunk', changedFiles: 0, changedFilesUnknown: true })
    expect(existsSync(marker)).toBe(false)
    // Control: a plain `git status` does run it, so the gate above is what prevented it.
    git(root, 'status', '--porcelain')
    expect(existsSync(marker)).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('refuses to run a git binary planted in the workspace', async () => {
    initRepo(root)
    writeFileSync(join(root, 'git.bat'), '@echo off\r\necho planted > planted.txt\r\n')
    expect(await new GitStatusReader().read(root)).toEqual({ isRepo: false, changedFiles: 0 })
    expect(existsSync(join(root, 'planted.txt'))).toBe(false)
  })
})
