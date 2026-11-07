import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These run real git many times per test, which on Windows under a full test run takes longer than the default allows.
vi.setConfig({ testTimeout: 60_000 })

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => home.dir }))

import { applyWorktree, copyIntoWorktree, createWorktree, detectSetup, planWorktree, removeWorktree, summarizeWorktree, withBaseline, worktreeDiff, worktreesRoot } from './worktrees'
import { createGitTools } from './tools/gitTools'

let repo: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  home.dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-home-')))
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  // These tests compare exact bytes, whatever line endings this machine's git prefers.
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'b.txt'), 'b\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
})

afterEach(() => {
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }) } catch { /* the test removed it */ }
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
  rmSync(home.dir, { recursive: true, force: true, maxRetries: 3 })
})

const create = async (options: Partial<Parameters<typeof createWorktree>[0]> = {}) => {
  const made = await createWorktree({ workspace: repo, title: 'Fix the bug', ...options })
  if (!made.ok) throw new Error(made.reason)
  return made
}

describe('planning a worktree', () => {
  it('reads the branch, what stays behind and how to set up', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    writeFileSync(join(repo, 'package-lock.json'), '{}')
    const plan = await planWorktree(join(repo, 'sub'))
    expect(plan).toMatchObject({ ok: true, repoRoot: repo, branch: 'main', uncommitted: 2, setup: ['npm ci'], setupFromProject: false })
  })

  it('prefers what the project says', async () => {
    mkdirSync(join(repo, '.cubex'))
    writeFileSync(join(repo, '.cubex', 'worktrees.json'), JSON.stringify({ setup: ['make deps', 7], copy: ['.env'] }))
    expect(await planWorktree(repo)).toMatchObject({ setup: ['make deps'], copy: ['.env'], setupFromProject: true })
  })

  it('explains what it cannot do', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cubex-plain-'))
    expect(await planWorktree(plain)).toMatchObject({ ok: false, reason: expect.stringContaining('not a git repository') })
    rmSync(plain, { recursive: true, force: true })
    const empty = mkdtempSync(join(tmpdir(), 'cubex-empty-'))
    git(empty, 'init', '-q')
    expect(await planWorktree(empty)).toMatchObject({ ok: false, reason: expect.stringContaining('no commits') })
    rmSync(empty, { recursive: true, force: true })
  })

  it('suggests a setup from the lockfile', () => {
    writeFileSync(join(repo, 'yarn.lock'), '')
    expect(detectSetup(repo)).toEqual(['yarn install --frozen-lockfile'])
  })
})

describe('a worktree', () => {
  it('is a separate checkout on a new branch, outside the project', async () => {
    const { worktree, workspacePath } = await create()
    expect(workspacePath).toBe(worktree.path)
    expect(worktree.path.startsWith(worktreesRoot())).toBe(true)
    expect(worktree.branch).toMatch(/^cubex\/fix-the-bug-/)
    expect(readFileSync(join(worktree.path, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    writeFileSync(join(worktree.path, 'a.txt'), 'other\n')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('keeps a task in the subfolder it was opened in', async () => {
    const { worktree, workspacePath } = await create({ workspace: join(repo, 'sub') })
    expect(workspacePath).toBe(join(worktree.path, 'sub'))
  })

  it('does not run the project hooks when created', async () => {
    const hooks = join(repo, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const marker = join(repo, 'hook-ran')
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    await create()
    expect(existsSync(marker)).toBe(false)
  })

  it('works with the git tools, whose guards refuse a redirected repository', async () => {
    const { worktree } = await create()
    writeFileSync(join(worktree.path, 'a.txt'), 'changed\n')
    const status = createGitTools(worktree.path).find((tool) => tool.definition.name === 'git_status')!
    const result = await status.execute({}, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('a.txt')
  })

  it('counts commits, edits and new files alike', async () => {
    const { worktree } = await create()
    expect(await summarizeWorktree(worktree)).toEqual({ exists: true, files: 0, additions: 0, deletions: 0, commits: 0 })
    writeFileSync(join(worktree.path, 'a.txt'), 'one\ntwo\nfour\n')
    git(worktree.path, 'config', 'user.email', 'test@example.com')
    git(worktree.path, 'config', 'user.name', 'Test')
    git(worktree.path, 'commit', '-qam', 'edit')
    writeFileSync(join(worktree.path, 'new.txt'), 'x\ny\n')
    writeFileSync(join(worktree.path, 'sub', 'b.txt'), 'c\n')
    expect(await summarizeWorktree(worktree)).toEqual({ exists: true, files: 3, additions: 4, deletions: 2, commits: 1 })
    const diff = await worktreeDiff(worktree)
    expect(diff).toContain('new.txt')
    expect(diff).toContain('+four')
  })
})

describe('what counts as the task\'s own work', () => {
  it('leaves out what setup wrote and what was copied in, so neither comes back to the project', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1')
    const made = await create({ copy: ['.env'] })
    writeFileSync(join(made.worktree.path, 'package-lock.json'), '{"from":"setup"}')
    const worktree = await withBaseline(made.worktree)
    expect(await summarizeWorktree(worktree)).toMatchObject({ files: 0 })

    writeFileSync(join(worktree.path, 'a.txt'), 'one\ntwo\nfour\n')
    expect(await summarizeWorktree(worktree)).toMatchObject({ files: 1 })
    expect(await worktreeDiff(worktree)).not.toContain('package-lock')
    expect(await applyWorktree(worktree)).toEqual({ ok: true, files: 1 })
    expect(existsSync(join(repo, 'package-lock.json'))).toBe(false)
  })

  it('looks at the folder without staging anything in it', async () => {
    const { worktree } = await create()
    writeFileSync(join(worktree.path, 'a.txt'), 'changed\n')
    writeFileSync(join(worktree.path, 'new.txt'), 'x\n')
    await summarizeWorktree(worktree)
    await worktreeDiff(worktree)
    await applyWorktree(worktree)
    expect(git(worktree.path, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(worktree.path, 'status', '--porcelain').split('\n').sort()).toEqual(['?? new.txt', 'M a.txt'])
  })

  it('keeps out what the project ignores', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'ignore')
    const { worktree } = await create()
    mkdirSync(join(worktree.path, 'node_modules'))
    writeFileSync(join(worktree.path, 'node_modules', 'x.js'), 'x')
    expect(await summarizeWorktree(worktree)).toMatchObject({ files: 0 })
  })

  it('takes the project path as the person spelled it', async () => {
    const plan = await planWorktree(`${repo}${repo.includes('\\') ? '\\' : '/'}sub${repo.includes('\\') ? '\\' : '/'}..`)
    expect(plan).toMatchObject({ repoRoot: repo })
  })
})

describe('copying files in', () => {
  it('brings plain files and refuses anything else', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1')
    const { worktree } = await create()
    expect(copyIntoWorktree(repo, worktree.path, ['.env', '../outside', '.git/config', 'missing.txt', join(repo, 'a.txt')]))
      .toEqual(['../outside', '.git/config', 'missing.txt', join(repo, 'a.txt')])
    expect(readFileSync(join(worktree.path, '.env'), 'utf8')).toBe('SECRET=1')
  })
})

describe('bringing a result back', () => {
  it('applies commits, edits and new files as uncommitted changes', async () => {
    const { worktree } = await create()
    writeFileSync(join(worktree.path, 'a.txt'), 'one\ntwo\nfour\n')
    writeFileSync(join(worktree.path, 'new.txt'), 'x\n')
    expect(await applyWorktree(worktree)).toEqual({ ok: true, files: 2 })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nfour\n')
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('x\n')
    expect(git(repo, 'status', '--porcelain').split('\n').sort()).toEqual(['?? new.txt', 'M a.txt'])
  })

  it('touches nothing when the change does not fit', async () => {
    const { worktree } = await create()
    writeFileSync(join(worktree.path, 'a.txt'), 'one\ntwo\nfour\n')
    writeFileSync(join(worktree.path, 'new.txt'), 'x\n')
    writeFileSync(join(repo, 'a.txt'), 'something else entirely\n')
    const result = await applyWorktree(worktree)
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(worktree.branch) })
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('something else entirely\n')
  })

  it('says so when there is nothing to bring', async () => {
    const { worktree } = await create()
    expect(await applyWorktree(worktree)).toMatchObject({ ok: false, reason: expect.stringContaining('no changes') })
  })

  it('refuses a path that is not a worktree of this project', async () => {
    const { worktree } = await create()
    const forged = { ...worktree, path: join(worktreesRoot(), 'other-12345678', 'abcd1234') }
    expect(await applyWorktree(forged)).toMatchObject({ ok: false })
    expect(await applyWorktree({ ...worktree, path: repo })).toMatchObject({ ok: false })
  })
})

describe('removing a worktree', () => {
  it('deletes the folder and the branch', async () => {
    const { worktree } = await create()
    writeFileSync(join(worktree.path, 'dirty.txt'), 'x')
    expect(await removeWorktree(worktree)).toEqual({ ok: true })
    expect(existsSync(worktree.path)).toBe(false)
    expect(git(repo, 'branch', '--list', worktree.branch)).toBe('')
  })

  it('tidies up after a folder deleted by hand', async () => {
    const { worktree } = await create()
    rmSync(worktree.path, { recursive: true, force: true })
    expect(await removeWorktree(worktree)).toEqual({ ok: true })
    expect(git(repo, 'branch', '--list', worktree.branch)).toBe('')
    expect(await summarizeWorktree(worktree)).toMatchObject({ exists: false })
  })

  it('never deletes a folder it did not create', async () => {
    const { worktree } = await create()
    const victim = mkdtempSync(join(tmpdir(), 'cubex-victim-'))
    writeFileSync(join(victim, 'keep.txt'), 'x')
    expect(await removeWorktree({ ...worktree, path: victim })).toMatchObject({ ok: false })
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
    expect(await removeWorktree({ ...worktree, path: repo })).toMatchObject({ ok: false })
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    rmSync(victim, { recursive: true, force: true })
  })
})
