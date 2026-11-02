import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitChanges, parseGitCommitRequest, suggestCommitMessage, type CommitOutcome } from './gitCommit'
import {
  commitCount, committedPaths, git, hasGit, initRepo, porcelain, posix, seedHistory as buildHistory, write, writeHook, writeProbe
} from './tools/gitTestHelpers'

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
