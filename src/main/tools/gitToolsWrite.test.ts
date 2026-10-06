import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JSONValue, ToolExecutionContext } from '@core/types'
import { createGitTools, type GitToolsOptions } from './gitTools'
import {
  commitCount, committedPaths, git, hasGit, initRepo, porcelain, seedHistory as buildHistory, write, writeHook
} from './gitTestHelpers'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

// Building a repository costs many git processes, so build one and copy it for each test.
let templateRoot = ''
let template = ''
const seedHistory = (dir: string): void => cpSync(template, dir, { recursive: true })

beforeAll(() => {
  if (!hasGit) return
  templateRoot = mkdtempSync(join(tmpdir(), 'cubex-git-write-template-'))
  template = join(templateRoot, 'repo')
  initRepo(template)
  buildHistory(template)
})

afterAll(() => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true })
})

async function call(
  workspace: string, name: string, input: JSONValue = {}, extra: { signal?: AbortSignal; options?: GitToolsOptions } = {}
): Promise<{ text: string; isError: boolean }> {
  const tool = createGitTools(workspace, extra.options).find((candidate) => candidate.definition.name === name)
  if (!tool) throw new Error(`No tool named ${name}`)
  const result = await tool.execute(input, extra.signal ? { ...ctx, signal: extra.signal } : ctx)
  return { text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), isError: !!result.isError }
}

describe.skipIf(!hasGit)('git_commit and git_branch', { timeout: 30_000 }, () => {
  let root: string
  let repo: string
  const head = (): string => git(repo, 'rev-parse', 'HEAD').trim()
  const currentBranch = (): string => git(repo, 'symbolic-ref', '--short', 'HEAD').trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-git-write-'))
    repo = join(root, 'repo')
    seedHistory(repo)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('git_commit', () => {
    it('commits the listed paths and reports what was committed', async () => {
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'new.txt', 'brand new\n')
      write(repo, 'scratch.txt', 'not listed\n')
      const result = await call(repo, 'git_commit', { message: 'Update a and add new', paths: ['a.txt', 'new.txt'] })
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(/Committed [0-9a-f]{7,} on trunk: Update a and add new/)
      expect(result.text).toMatch(/2 files changed/)
      expect(result.text).toContain('a.txt')
      expect(result.text).toContain('new.txt')
      expect(committedPaths(repo)).toEqual(['a.txt', 'new.txt'])
      expect(porcelain(repo)).toEqual(['?? scratch.txt'])
    })

    it('keeps a file the user already staged out of the commit', async () => {
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'staged.txt', 'staged by the user\n')
      git(repo, 'add', 'staged.txt')
      expect((await call(repo, 'git_commit', { message: 'Only a', paths: ['a.txt'] })).isError).toBe(false)
      expect(committedPaths(repo)).toEqual(['a.txt'])
      expect(porcelain(repo)).toEqual(['A  staged.txt'])
    })

    it('without paths commits tracked changes and never untracked files', async () => {
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'untracked.txt', 'x')
      const result = await call(repo, 'git_commit', { message: 'Tracked only', paths: null })
      expect(result.isError).toBe(false)
      expect(committedPaths(repo)).toEqual(['a.txt'])
      expect(porcelain(repo)).toEqual(['?? untracked.txt'])
    })

    it('refuses empty messages, nothing to commit, and malformed arguments', async () => {
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const before = head()
      for (const input of [
        {}, { message: '' }, { message: '   ' }, { message: 7 }, { message: 'x'.repeat(2001), paths: ['a.txt'] },
        { message: 'x', paths: 'a.txt' }, { message: 'x', paths: [1] }, { message: 'x', paths: [] }, { message: 'x', paths: ['a.txt', ''] }
      ] as JSONValue[]) {
        expect((await call(repo, 'git_commit', input)).isError, JSON.stringify(input)).toBe(true)
      }
      expect((await call(repo, 'git_commit', 'nope' as unknown as JSONValue)).isError).toBe(true)
      expect(head()).toBe(before)
      git(repo, 'checkout', '-q', '--', 'a.txt')
      const clean = await call(repo, 'git_commit', { message: 'Nothing here' })
      expect(clean.isError).toBe(true)
      expect(clean.text).toMatch(/nothing to commit/i)
    })

    it('refuses paths outside the workspace and treats option-like input as data', async () => {
      write(root, 'outside.txt', 'outside')
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const before = head()
      for (const path of ['../outside.txt', join(root, 'outside.txt'), '.git/config', ':(top)a.txt']) {
        expect((await call(repo, 'git_commit', { message: 'x', paths: [path] })).isError, path).toBe(true)
      }
      expect(head()).toBe(before)
      const amend = await call(repo, 'git_commit', { message: '--amend', paths: ['a.txt'] })
      expect(amend.isError).toBe(false)
      expect(commitCount(repo)).toBe(3)
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('--amend')
    })

    it('returns the hook output when a hook rejects the commit', async () => {
      writeHook(repo, 'pre-commit', 'echo "lint: forbidden word" >&2\nexit 1')
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const before = head()
      const result = await call(repo, 'git_commit', { message: 'Rejected', paths: ['a.txt'] })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('lint: forbidden word')
      expect(head()).toBe(before)
    })

    it('stops waiting for a hook that never finishes, and can be cancelled', async () => {
      writeHook(repo, 'pre-commit', 'sleep 30')
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const slow = await call(repo, 'git_commit', { message: 'Slow', paths: ['a.txt'] }, { options: { commitTimeoutMs: 1_500 } })
      expect(slow.isError).toBe(true)
      expect(slow.text).toMatch(/did not finish in time/i)

      // No manual clean-up of lock files is needed before the next attempt.
      const controller = new AbortController()
      const pending = call(repo, 'git_commit', { message: 'Cancelled', paths: ['a.txt'] }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 700)
      const cancelled = await pending
      expect(cancelled.isError).toBe(true)
      expect(cancelled.text).toMatch(/cancel/i)
    })
  })

  describe('git_branch', () => {
    it('creates a branch at HEAD without switching to it', async () => {
      const result = await call(repo, 'git_branch', { name: 'feature/x' })
      expect(result.isError).toBe(false)
      expect(result.text).toContain('feature/x')
      expect(git(repo, 'rev-parse', 'feature/x').trim()).toBe(head())
      expect(currentBranch()).toBe('trunk')
    })

    it('creates a branch from another revision', async () => {
      const result = await call(repo, 'git_branch', { name: 'old', from: 'HEAD~1' })
      expect(result.isError).toBe(false)
      expect(git(repo, 'rev-parse', 'old').trim()).toBe(git(repo, 'rev-parse', 'HEAD~1').trim())
      expect(currentBranch()).toBe('trunk')
    })

    it('switches to the new branch when asked and keeps uncommitted work', async () => {
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const result = await call(repo, 'git_branch', { name: 'work', checkout: true })
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(/switched/i)
      expect(currentBranch()).toBe('work')
      expect(porcelain(repo)).toEqual([' M a.txt'])
    })

    it('never moves or replaces an existing branch', async () => {
      git(repo, 'branch', 'keep', 'HEAD~1')
      const before = git(repo, 'rev-parse', 'keep').trim()
      const result = await call(repo, 'git_branch', { name: 'keep', from: 'HEAD' })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/already exists/i)
      expect(git(repo, 'rev-parse', 'keep').trim()).toBe(before)
    })

    it.each([
      '', '-x', '--force', '-', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '@', '@{-1}', 'x.lock', 'x/', '/x',
      'x//y', '.hidden', 'x\ny', 'HEAD', 'a'.repeat(300)
    ])('refuses the branch name %j', async (name) => {
      const before = git(repo, 'branch', '--list').trim()
      const result = await call(repo, 'git_branch', { name })
      expect(result.isError).toBe(true)
      expect(git(repo, 'branch', '--list').trim()).toBe(before)
    })

    it('refuses a starting point that is not a commit, or that looks like an option', async () => {
      for (const from of ['no-such-revision', '--output=pwned.txt', '-b', 'HEAD:a.txt', ' HEAD', '']) {
        const result = await call(repo, 'git_branch', { name: 'x', from })
        expect(result.isError, JSON.stringify(from)).toBe(true)
      }
      expect(existsSync(join(repo, 'pwned.txt'))).toBe(false)
      expect(git(repo, 'branch', '--list', 'x').trim()).toBe('')
    })

    it('does not force a switch over local changes', async () => {
      write(repo, 'a.txt', 'local edit\n')
      const result = await call(repo, 'git_branch', { name: 'conflict', from: 'HEAD~1', checkout: true })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/overwritten|local changes/i)
      expect(currentBranch()).toBe('trunk')
      expect(git(repo, 'branch', '--list', 'conflict').trim()).toBe('')
      expect(porcelain(repo)).toEqual([' M a.txt'])
    })

    it('validates its arguments', async () => {
      for (const input of [{}, { name: 7 }, { name: 'x', checkout: 'yes' }, { name: 'x', from: 7 }] as JSONValue[]) {
        expect((await call(repo, 'git_branch', input)).isError, JSON.stringify(input)).toBe(true)
      }
      expect((await call(repo, 'git_branch', { name: 'ok', from: null, checkout: null })).isError).toBe(false)
    })
  })
})
