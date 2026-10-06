import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitChanges, parseGitCommitRequest, suggestCommitMessage, type CommitOutcome } from './gitCommit'
import {
  commitCount, committedPaths, git, hasGit, initRepo, porcelain, posix, seedHistory as buildHistory, write, writeHook, writeProbe
} from './tools/gitTestHelpers'

/** Run `fn` with environment overrides (undefined removes a variable), then restore the environment exactly. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return await fn() } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

function expectOk(outcome: CommitOutcome): Extract<CommitOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`Expected a commit, got: ${outcome.error}`)
  return outcome
}

describe.skipIf(!hasGit)('commitChanges', { timeout: 30_000 }, () => {
  let root: string
  let repo: string
  let templateRoot: string
  let template: string

  const seedHistory = (dir: string): void => cpSync(template, dir, { recursive: true })
  const head = (dir = repo): string => git(dir, 'rev-parse', 'HEAD').trim()

  beforeAll(() => {
    templateRoot = mkdtempSync(join(tmpdir(), 'cubex-git-commit-template-'))
    template = join(templateRoot, 'repo')
    initRepo(template)
    buildHistory(template)
  })

  afterAll(() => {
    rmSync(templateRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-git-commit-'))
    repo = join(root, 'repo')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('commits exactly the listed paths and leaves everything else as it was', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n') // modified, listed
    write(repo, 'sub/b.txt', 'bee\nbuzz\n') // modified, not listed
    write(repo, 'new.txt', 'brand new\n') // untracked, listed
    write(repo, 'scratch.txt', 'keep me\n') // untracked, not listed
    write(repo, 'staged.txt', 'the user staged this\n') // staged by the user, not listed
    git(repo, 'add', 'staged.txt')
    const before = commitCount(repo)

    const result = expectOk(await commitChanges(repo, { message: 'Update a and add new', paths: ['a.txt', 'new.txt'] }))

    expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(result.commit).toBe(git(repo, 'rev-parse', '--short', 'HEAD').trim())
    expect(result.branch).toBe('trunk')
    expect(result.subject).toBe('Update a and add new')
    expect(result.summary).toContain('Update a and add new')
    expect(result.summary).toMatch(/2 files changed/)
    expect(result.files.map((file) => file.path).sort()).toEqual(['a.txt', 'new.txt'])
    expect(commitCount(repo)).toBe(before + 1)
    expect(committedPaths(repo)).toEqual(['a.txt', 'new.txt'])
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('Update a and add new')
    // The user's staged file stays staged; the other changes stay where they were.
    expect(porcelain(repo)).toEqual([' M sub/b.txt', '?? scratch.txt', 'A  staged.txt'].sort())
  })

  it('commits a deletion', async () => {
    seedHistory(repo)
    rmSync(join(repo, 'sub', 'b.txt'))
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    expectOk(await commitChanges(repo, { message: 'Remove b', paths: ['sub/b.txt'] }))
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('sub/b.txt')
    expect(porcelain(repo)).toEqual([' M a.txt'])
  })

  it('accepts an absolute path inside the workspace', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    expectOk(await commitChanges(repo, { message: 'Absolute', paths: [join(repo, 'a.txt')] }))
    expect(committedPaths(repo)).toEqual(['a.txt'])
  })

  it.skipIf(process.platform !== 'win32')('accepts Windows path separators', async () => {
    seedHistory(repo)
    write(repo, 'sub/b.txt', 'bee\nbuzz\n')
    expectOk(await commitChanges(repo, { message: 'Backslash', paths: ['sub\\b.txt'] }))
    expect(committedPaths(repo)).toEqual(['sub/b.txt'])
  })

  it('without paths commits tracked modifications and deletions, never untracked files', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    rmSync(join(repo, 'sub', 'b.txt'))
    write(repo, 'untracked.txt', 'never committed by accident\n')
    expectOk(await commitChanges(repo, { message: 'Tracked changes' }))
    expect(committedPaths(repo)).toEqual(['a.txt', 'sub/b.txt'])
    expect(porcelain(repo)).toEqual(['?? untracked.txt'])
  })

  it('works from a folder inside the repository and never touches files outside it', async () => {
    seedHistory(repo)
    const workspace = join(repo, 'sub')
    write(repo, 'sub/b.txt', 'bee\nbuzz\n')
    write(repo, 'a.txt', 'changed outside the workspace\n')
    write(repo, 'outside-staged.txt', 'staged outside\n')
    git(repo, 'add', 'outside-staged.txt')

    const refused = await commitChanges(workspace, { message: 'Escape', paths: ['../a.txt'] })
    expect(refused).toMatchObject({ ok: false })

    expectOk(await commitChanges(workspace, { message: 'Everything tracked in sub' }))
    expect(committedPaths(repo)).toEqual(['sub/b.txt'])
    expect(porcelain(repo)).toEqual([' M a.txt', 'A  outside-staged.txt'].sort())
    write(repo, 'sub/b.txt', 'bee\nbuzz\nbuzz2\n')
    expectOk(await commitChanges(workspace, { message: 'One file', paths: ['b.txt'] }))
    expect(committedPaths(repo)).toEqual(['sub/b.txt'])
  })

  it('makes the first commit on an unborn branch and keeps other staged work', async () => {
    initRepo(repo)
    write(repo, 'a.txt', 'one\n')
    write(repo, 'other.txt', 'other\n')
    git(repo, 'add', 'other.txt')
    const result = expectOk(await commitChanges(repo, { message: 'Initial commit', paths: ['a.txt'] }))
    expect(result.subject).toBe('Initial commit')
    expect(committedPaths(repo)).toEqual(['a.txt'])
    expect(porcelain(repo)).toEqual(['A  other.txt'])
  })

  it('refuses a commit with nothing to commit', async () => {
    seedHistory(repo)
    const before = head()
    for (const request of [{ message: 'x', paths: ['a.txt'] }, { message: 'x' }, { message: 'x', paths: ['sub'] }]) {
      const outcome = await commitChanges(repo, request)
      expect(outcome).toMatchObject({ ok: false })
      if (!outcome.ok) expect(outcome.error).toMatch(/nothing to commit/i)
    }
    write(repo, '.gitignore', 'ignored.txt\n')
    write(repo, 'ignored.txt', 'x')
    const ignored = await commitChanges(repo, { message: 'x', paths: ['ignored.txt'] })
    expect(ignored.ok).toBe(false)
    if (!ignored.ok) expect(ignored.error).toMatch(/nothing to commit.*gitignore/is)
    expect(head()).toBe(before)
  })

  it('reports a path that git does not know, or that .gitignore hides, in plain words', async () => {
    seedHistory(repo)
    write(repo, '.gitignore', 'ignored.txt\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-q', '-m', 'ignore')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    write(repo, 'ignored.txt', 'never committed\n')
    const before = head()
    for (const [path, reason] of [['missing.txt', /not found|missing/i], ['ignored.txt', /gitignore/i]] as const) {
      const outcome = await commitChanges(repo, { message: 'x', paths: ['a.txt', path] })
      expect(outcome.ok, path).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error, path).toContain(path)
        expect(outcome.error, path).toMatch(reason)
        expect(outcome.error, path).not.toContain(':(literal)')
      }
    }
    expect(head()).toBe(before)
    expect(porcelain(repo)).toEqual([' M a.txt'])
    // A tracked file with no changes is harmless next to a real change.
    expectOk(await commitChanges(repo, { message: 'Unchanged neighbour', paths: ['a.txt', 'sub/b.txt'] }))
    expect(committedPaths(repo)).toEqual(['a.txt'])
  })

  it('rejects unusable messages', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const before = head()
    for (const message of [undefined, 7, '', '   \n\t ', 'x'.repeat(2001), 'a\0b'] as unknown[]) {
      expect(await commitChanges(repo, { message, paths: ['a.txt'] }), String(message)).toMatchObject({ ok: false })
    }
    expect(head()).toBe(before)
    expectOk(await commitChanges(repo, { message: 'y'.repeat(2000), paths: ['a.txt'] }))
  })

  it('rejects unusable paths and never leaves the workspace', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    write(root, 'outside.txt', 'outside')
    const before = head()
    const requests: unknown[] = [
      ['../outside.txt'], [join(root, 'outside.txt')], ['.git/config'], [':(top)a.txt'], [':/'], ['.'], [''], [7], [], 'a.txt', null,
      Array.from({ length: 201 }, (_, index) => `f${index}.txt`), ['a.txt', '../outside.txt']
    ]
    for (const paths of requests) {
      expect(await commitChanges(repo, { message: 'x', paths }), JSON.stringify(paths)).toMatchObject({ ok: false })
    }
    expect(head()).toBe(before)
    expect(porcelain(repo)).toEqual([' M a.txt'])
  })

  it('does not let a message or a path act as an option', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const before = commitCount(repo)
    expectOk(await commitChanges(repo, { message: '--amend', paths: ['a.txt'] }))
    expect(commitCount(repo)).toBe(before + 1)
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('--amend')

    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n')
    expectOk(await commitChanges(repo, { message: '-m injected\n\nBody line', paths: ['a.txt'] }))
    expect(git(repo, 'log', '-1', '--format=%B').trim()).toBe('-m injected\n\nBody line')

    write(repo, '-rf.txt', 'x')
    write(repo, '--all', 'y')
    expectOk(await commitChanges(repo, { message: 'Dash files', paths: ['-rf.txt', '--all'] }))
    expect(committedPaths(repo)).toEqual(['--all', '-rf.txt'])
    expect(commitCount(repo)).toBe(before + 3)
  })

  it('keeps multi-line and non-ASCII messages intact', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const message = 'Café: add “quotes” and 日本語\n\nSecond paragraph.\n- bullet'
    expectOk(await commitChanges(repo, { message, paths: ['a.txt'] }))
    expect(git(repo, 'log', '-1', '--format=%B').trim()).toBe(message)
  })

  it('reports a failing hook with its output and changes nothing', async () => {
    seedHistory(repo)
    writeHook(repo, 'pre-commit', 'echo "lint: forbidden word" >&2\necho "stdout from the hook"\necho ran > .git/hook-ran\nexit 1')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    write(repo, 'new.txt', 'brand new\n')
    write(repo, 'staged.txt', 'staged\n')
    git(repo, 'add', 'staged.txt')
    const before = head()
    const statusBefore = porcelain(repo)

    const outcome = await commitChanges(repo, { message: 'Will be rejected', paths: ['a.txt', 'new.txt'] })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('lint: forbidden word')
      expect(outcome.error).toContain('stdout from the hook')
    }
    expect(existsSync(join(repo, '.git', 'hook-ran'))).toBe(true)
    expect(head()).toBe(before)
    // The new file is untracked again and nothing else moved.
    expect(porcelain(repo)).toEqual(statusBefore)
  })

  it('runs hooks normally on success and surfaces a rejecting commit-msg hook', async () => {
    seedHistory(repo)
    writeHook(repo, 'pre-commit', 'echo ran > .git/pre-commit-ran')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    expectOk(await commitChanges(repo, { message: 'Hooks run', paths: ['a.txt'] }))
    expect(existsSync(join(repo, '.git', 'pre-commit-ran'))).toBe(true)

    writeHook(repo, 'commit-msg', 'echo "message rejected: needs a ticket number" >&2\nexit 1')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n')
    const before = head()
    const outcome = await commitChanges(repo, { message: 'No ticket', paths: ['a.txt'] })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('needs a ticket number')
    expect(head()).toBe(before)
  })

  it('tells the user how to set an identity instead of guessing one', async () => {
    initRepo(repo, false)
    write(repo, 'a.txt', 'one\n')
    const outcome = await withEnv({
      GIT_CONFIG_GLOBAL: join(root, 'no-such-config'), GIT_CONFIG_NOSYSTEM: '1',
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home'),
      EMAIL: undefined, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined
    }, () => commitChanges(repo, { message: 'Needs an identity', paths: ['a.txt'] }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/git config --global user\.name/)
      expect(outcome.error).toMatch(/user\.email/)
    }
    expect(() => git(repo, 'rev-parse', '--verify', 'HEAD')).toThrow()
  })

  it('stops a hook that runs too long and leaves the repository usable', async () => {
    seedHistory(repo)
    writeHook(repo, 'pre-commit', 'sleep 30')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    write(repo, 'new.txt', 'brand new\n')
    const started = Date.now()
    const outcome = await commitChanges(repo, { message: 'Slow hook', paths: ['a.txt', 'new.txt'] }, { timeoutMs: 1_500 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/did not finish in time/i)
    expect(Date.now() - started).toBeLessThan(15_000)
    // A killed git cannot clean up after itself, so the lock files it left must be gone.
    expect(readdirSync(join(repo, '.git')).filter((name) => /\.lock$/.test(name))).toEqual([])
    expect(porcelain(repo)).toEqual([' M a.txt', '?? new.txt'])
    // The same commit goes through once the hook is out of the way.
    rmSync(join(repo, '.git', 'hooks', 'pre-commit'))
    expectOk(await commitChanges(repo, { message: 'Retry', paths: ['a.txt', 'new.txt'] }))
    expect(committedPaths(repo)).toEqual(['a.txt', 'new.txt'])
  })

  it('can be cancelled while a hook runs, and leaves the repository usable', async () => {
    seedHistory(repo)
    writeHook(repo, 'pre-commit', 'sleep 30')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const controller = new AbortController()
    const pending = commitChanges(repo, { message: 'Cancelled', paths: ['a.txt'] }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 700)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/cancel/i)
    expect(readdirSync(join(repo, '.git')).filter((name) => /\.lock$/.test(name))).toEqual([])
    rmSync(join(repo, '.git', 'hooks', 'pre-commit'))
    expectOk(await commitChanges(repo, { message: 'After cancel', paths: ['a.txt'] }))
  })

  it('runs one commit at a time per repository', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    write(repo, 'sub/b.txt', 'bee\nbuzz\n')
    const before = commitCount(repo)
    const [first, second] = await Promise.all([
      commitChanges(repo, { message: 'First', paths: ['a.txt'] }),
      commitChanges(repo, { message: 'Second', paths: ['sub/b.txt'] })
    ])
    expectOk(first)
    expectOk(second)
    expect(commitCount(repo)).toBe(before + 2)
    expect(porcelain(repo)).toEqual([])
  })

  it('fails clearly outside a repository and without a workspace', async () => {
    const plain = join(root, 'plain')
    write(plain, 'a.txt', 'x')
    const outside = await commitChanges(plain, { message: 'x', paths: ['a.txt'] })
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.error).toMatch(/not a git repository|not inside a git repository/i)
    expect(await commitChanges(undefined, { message: 'x', paths: ['a.txt'] })).toMatchObject({ ok: false })
  })

  it('commits on a detached HEAD and reports no branch name', async () => {
    seedHistory(repo)
    git(repo, 'checkout', '-q', '--detach')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const result = expectOk(await commitChanges(repo, { message: 'Detached', paths: ['a.txt'] }))
    expect(result.branch).toBeUndefined()
    expect(result.commit).toBe(git(repo, 'rev-parse', '--short', 'HEAD').trim())
  })

  it('handles file names with spaces and non-ASCII characters', async () => {
    seedHistory(repo)
    const names = ['my notes.txt', 'café ☕.txt', '日本語/ファイル.txt']
    for (const name of names) write(repo, name, `${name}\n`)
    const result = expectOk(await commitChanges(repo, { message: 'Odd names', paths: names }))
    expect(committedPaths(repo)).toEqual([...names].sort())
    expect(result.files.map((file) => file.path).sort()).toEqual([...names].sort())
    expect(porcelain(repo)).toEqual([])
  })

  it('refuses a link that leads out of the workspace, as a folder or as the path itself', async () => {
    seedHistory(repo)
    write(root, 'outside-dir/secret.txt', 'secret')
    const link = join(repo, 'link')
    try {
      symlinkSync(join(root, 'outside-dir'), link, 'junction')
    } catch { return } // Creating links needs a privilege on some systems.
    try {
      const before = head()
      for (const paths of [['link'], ['link/secret.txt'], ['a.txt', 'link/secret.txt']]) {
        expect(await commitChanges(repo, { message: 'x', paths }), JSON.stringify(paths)).toMatchObject({ ok: false })
      }
      expect(head()).toBe(before)
    } finally {
      try { unlinkSync(link) } catch { rmdirSync(link) }
    }
  })

  it('refuses to commit when the repository redirects its working tree elsewhere', async () => {
    seedHistory(repo)
    write(root, 'victim/a.txt', 'TOP-SECRET-1\nTOP-SECRET-2\n')
    git(repo, 'config', 'core.worktree', posix(join(root, 'victim')))
    const before = head()
    const outcome = await commitChanges(repo, { message: 'Would commit an outside file', paths: ['a.txt'] })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/working tree/i)
    expect(head()).toBe(before)
    const everything = await commitChanges(repo, { message: 'x' })
    expect(everything.ok).toBe(false)
  })

  it('treats glob characters in a file name literally, so a sibling is never committed with it', async () => {
    seedHistory(repo)
    write(repo, 'file1.txt', 'a sibling that a glob would match\n')
    git(repo, 'add', 'file1.txt')
    git(repo, 'commit', '-q', '-m', 'sibling')
    write(repo, 'file1.txt', 'sibling changed\n')
    write(repo, 'file[1].txt', 'brackets are legal in file names\n')
    expectOk(await commitChanges(repo, { message: 'Brackets', paths: ['file[1].txt'] }))
    expect(committedPaths(repo)).toEqual(['file[1].txt'])
    expect(porcelain(repo)).toEqual([' M file1.txt'])
  })

  it('leaves the pathspec behaviour of hooks alone', async () => {
    seedHistory(repo)
    // A hook that globs, as many do. A literal-pathspec setting leaked into the hook would match nothing.
    writeHook(repo, 'pre-commit', "git diff --cached --name-only -- '*.txt' > .git/hook-saw")
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    expectOk(await commitChanges(repo, { message: 'Hook sees globs', paths: ['a.txt'] }))
    expect(readFileSync(join(repo, '.git', 'hook-saw'), 'utf8').trim()).toBe('a.txt')
  })

  it('is not thrown off by pathspec settings in the user environment', async () => {
    seedHistory(repo)
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const outcome = await withEnv({ GIT_LITERAL_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1', GIT_GLOB_PATHSPECS: '1', GIT_NOGLOB_PATHSPECS: '1' },
      () => commitChanges(repo, { message: 'Environment pathspec modes', paths: ['a.txt'] }))
    expectOk(outcome)
    expect(committedPaths(repo)).toEqual(['a.txt'])
  })

  it('never runs a program that the repository configures for the commit pre-checks', async () => {
    seedHistory(repo)
    const { script, ran } = writeProbe(root)
    git(repo, 'config', 'core.fsmonitor', `"${script}"`)
    rmSync(ran, { force: true })
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    expectOk(await commitChanges(repo, { message: 'No fsmonitor', paths: ['a.txt'] }))
    expect(existsSync(ran)).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('refuses to run a git program planted in the workspace', async () => {
    seedHistory(repo)
    write(repo, 'git.bat', '@echo off\r\necho planted > planted.txt\r\n')
    write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const outcome = await commitChanges(repo, { message: 'x', paths: ['a.txt'] })
    expect(outcome.ok).toBe(false)
    expect(existsSync(join(repo, 'planted.txt'))).toBe(false)
  })
})

describe('parseGitCommitRequest', () => {
  it('accepts a message of 1 to 2000 characters and up to 200 paths', () => {
    expect(parseGitCommitRequest({ message: 'Fix it', paths: ['a.txt', 'sub/b.txt'] }))
      .toEqual({ ok: true, value: { message: 'Fix it', paths: ['a.txt', 'sub/b.txt'] } })
    expect(parseGitCommitRequest({ message: 'x'.repeat(2000), paths: ['a'] }).ok).toBe(true)
    expect(parseGitCommitRequest({ message: 'x', paths: Array.from({ length: 200 }, (_, index) => `f${index}`) }).ok).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['null', null], ['a string', 'x'], ['an array', []],
    ['a numeric message', { message: 1, paths: ['a'] }], ['no message', { paths: ['a'] }],
    ['an empty message', { message: '', paths: ['a'] }], ['a blank message', { message: ' \n\t', paths: ['a'] }],
    ['a message over 2000 characters', { message: 'x'.repeat(2001), paths: ['a'] }],
    ['a NUL in the message', { message: 'a\0b', paths: ['a'] }],
    ['no paths', { message: 'x' }], ['empty paths', { message: 'x', paths: [] }], ['paths that are not a list', { message: 'x', paths: 'a' }],
    ['more than 200 paths', { message: 'x', paths: Array.from({ length: 201 }, (_, index) => `f${index}`) }],
    ['a non-string path', { message: 'x', paths: [1] }], ['an empty path', { message: 'x', paths: [''] }],
    ['a NUL in a path', { message: 'x', paths: ['a\0b'] }], ['an over-long path', { message: 'x', paths: ['a'.repeat(4097)] }]
  ])('rejects %s with a plain error', (_label, value) => {
    const parsed = parseGitCommitRequest(value)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/^[A-Z].*\.$/)
  })
})

describe('suggestCommitMessage', () => {
  const change = (path: string, status: 'added' | 'modified' | 'deleted') => ({ path, status })

  it('writes imperative subjects for the common cases', () => {
    expect(suggestCommitMessage([change('src/client.ts', 'modified'), change('src/backoff.ts', 'added')])).toBe('Update client.ts and add backoff.ts')
    expect(suggestCommitMessage([change('a.ts', 'added')])).toBe('Add a.ts')
    expect(suggestCommitMessage([change('old.ts', 'deleted')])).toBe('Remove old.ts')
    expect(suggestCommitMessage([change('a.ts', 'modified'), change('b.ts', 'modified'), change('c.ts', 'modified')])).toBe('Update a.ts, b.ts and c.ts')
    expect(suggestCommitMessage([change('a.ts', 'modified'), change('b.ts', 'added'), change('c.ts', 'deleted')])).toBe('Update a.ts, add b.ts and remove c.ts')
    expect(suggestCommitMessage([])).toBe('')
  })

  it('tells same-named files apart by the shortest unique path suffix', () => {
    expect(suggestCommitMessage([change('src/index.ts', 'modified'), change('src/ui/index.ts', 'modified')])).toBe('Update src/index.ts and ui/index.ts')
  })

  it('does not depend on the order of the changes', () => {
    const changes = [change('z.ts', 'added'), change('a.ts', 'modified'), change('m.ts', 'deleted'), change('b.ts', 'modified')]
    const expected = suggestCommitMessage(changes)
    expect(suggestCommitMessage([...changes].reverse())).toBe(expected)
    expect(expected).toBe('Update a.ts and b.ts, add z.ts and remove m.ts')
  })

  it('falls back to counts when the names would not fit', () => {
    const modified = Array.from({ length: 12 }, (_, index) => change(`src/module-number-${index}.ts`, 'modified'))
    expect(suggestCommitMessage(modified)).toBe('Update 12 files')
    const mixed = [...modified.slice(0, 6), ...Array.from({ length: 3 }, (_, index) => change(`docs/page-number-${index}.md`, 'added'))]
    expect(suggestCommitMessage(mixed)).toBe('Update 6 files and add 3 files')
    expect(suggestCommitMessage([change('client.ts', 'modified'), ...Array.from({ length: 30 }, (_, index) => change(`generated/file-${index}.json`, 'added'))]))
      .toBe('Update client.ts and add 30 files')
  })

  it('never exceeds 72 characters', () => {
    const long = `deeply/nested/${'a'.repeat(100)}.ts`
    const single = suggestCommitMessage([change(long, 'modified')])
    expect(single.length).toBeLessThanOrEqual(72)
    expect(single.startsWith('Update ')).toBe(true)
    expect(single.endsWith('…')).toBe(true)
    for (const size of [1, 2, 3, 5, 8, 13, 40]) {
      const verbs = ['modified', 'added', 'deleted'] as const
      const changes = Array.from({ length: size }, (_, index) => change(`dir${index % 4}/some-fairly-long-file-name-${index}.ts`, verbs[index % 3]!))
      expect(suggestCommitMessage(changes).length, String(size)).toBeLessThanOrEqual(72)
    }
  })
})
