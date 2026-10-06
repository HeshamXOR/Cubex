import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isReadOnlyShellCommand, repositoryConfigIsInert } from './shellReadOnly'
import { git, hasGit, initRepo, posix, seedHistory, write } from './gitTestHelpers'

/**
 * `git diff`, `git status` and `git blame` are auto-approved when the repository's own
 * config cannot make them run programs or read beyond the workspace. These settings can.
 */
describe.skipIf(!hasGit)('read-only git classification and repository settings', { timeout: 30_000 }, () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-readonly-git-'))
    repo = join(root, 'repo')
    initRepo(repo)
    seedHistory(repo)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const commands = ['git status', 'git diff', 'git diff HEAD', 'git blame a.txt', 'git log']

  it('auto-approves them in an ordinary repository', () => {
    expect(repositoryConfigIsInert(repo)).toBe(true)
    for (const command of commands) expect(isReadOnlyShellCommand(command, repo), command).toBe(true)
  })

  it.each([
    ['core.worktree', () => posix(join(root, 'elsewhere'))],
    ['blame.ignoreRevsFile', () => posix(join(root, 'secret.env'))],
    ['filter.a.b.clean', () => 'cat'],
    ['filter.my.driver.smudge', () => 'cat'],
    ['diff.my.driver.textconv', () => 'cat'],
    ['merge.my.driver.driver', () => 'cat']
  ])('sends them for approval when the repository sets %s', (key, value) => {
    git(repo, 'config', key, value())
    expect(repositoryConfigIsInert(repo), key).toBe(false)
    for (const command of commands) expect(isReadOnlyShellCommand(command, repo), `${key}: ${command}`).toBe(false)
  })

  it('still asks about settings it already knew', () => {
    write(root, 'noop', '')
    git(repo, 'config', 'core.fsmonitor', 'true')
    expect(repositoryConfigIsInert(repo)).toBe(false)
  })
})
