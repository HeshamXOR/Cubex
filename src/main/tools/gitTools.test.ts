import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JSONValue, ToolExecutionContext } from '@core/types'
import { createGitTools } from './gitTools'
import { fastImportCommits, git, hasGit, initRepo, posix, seedHistory as buildHistory, write, writeProbe } from './gitTestHelpers'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

// Building a repository costs many git processes, so build one and copy it for each test.
let templateRoot = ''
let template = ''
const seedHistory = (dir: string): void => cpSync(template, dir, { recursive: true })

beforeAll(() => {
  if (!hasGit) return
  templateRoot = mkdtempSync(join(tmpdir(), 'cubex-git-template-'))
  template = join(templateRoot, 'repo')
  initRepo(template)
  buildHistory(template)
})

afterAll(() => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true })
})

async function call(workspace: string, name: string, input: JSONValue = {}): Promise<{ text: string; isError: boolean }> {
  const tool = createGitTools(workspace).find((candidate) => candidate.definition.name === name)
  if (!tool) throw new Error(`No tool named ${name}`)
  const result = await tool.execute(input, ctx)
  return { text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), isError: !!result.isError }
}

describe('git tool definitions', () => {
  const tools = createGitTools(tmpdir())

  it('lets the read-only tools run without a prompt and asks before anything that writes', () => {
    expect(Object.fromEntries(tools.map((tool) => [tool.definition.name, tool.defaultPermission]))).toEqual({
      git_status: 'allow', git_diff: 'allow', git_log: 'allow', git_show: 'allow', git_blame: 'allow',
      git_commit: 'ask', git_branch: 'ask'
    })
  })

  it('offers no push, reset, clean, rebase, force, stash or amend operation', () => {
    const forbiddenTool = /push|reset|clean|rebase|force|stash|amend|no.?verify|checkout|restore/i
    const forbiddenOption = /push|reset|clean|rebase|force|stash|amend|no.?verify|hard|discard|allow.?empty/i
    for (const tool of tools) {
      expect(tool.definition.name).not.toMatch(forbiddenTool)
      const properties = Object.keys((tool.definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      for (const property of properties) expect(property).not.toMatch(forbiddenOption)
    }
  })

  it('describes every tool and requires its mandatory inputs', () => {
    const required = (name: string): unknown => (tools.find((tool) => tool.definition.name === name)!.definition.inputSchema as { required?: string[] }).required
    for (const tool of tools) expect(tool.definition.description?.length ?? 0).toBeGreaterThan(40)
    expect(required('git_show')).toEqual(['rev'])
    expect(required('git_blame')).toEqual(['path'])
    expect(required('git_commit')).toEqual(['message'])
    expect(required('git_branch')).toEqual(['name'])
  })
})

describe.skipIf(!hasGit)('read-only git tools', { timeout: 30_000 }, () => {
  let root: string
  let repo: string

  /** Remove a link without following it (rmSync would walk into the target on Windows). */
  const dropLink = (path: string): void => {
    try { unlinkSync(path) } catch { try { rmdirSync(path) } catch { /* Already gone. */ } }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-git-tools-'))
    repo = join(root, 'repo')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('git_status', () => {
    it('summarizes the branch, staged, unstaged and untracked files', async () => {
      seedHistory(repo)
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'sub/b.txt', 'bee\nbuzz\n')
      git(repo, 'add', 'sub/b.txt')
      write(repo, 'new file.txt', 'x')
      const result = await call(repo, 'git_status')
      expect(result.isError).toBe(false)
      expect(result.text).toContain('On branch trunk')
      expect(result.text).toMatch(/Staged changes \(1\):\n\s+modified\s+sub\/b\.txt/)
      expect(result.text).toMatch(/Unstaged changes \(1\):\n\s+modified\s+a\.txt/)
      expect(result.text).toMatch(/Untracked files \(1\):\n\s+new file\.txt/)
    })

    it('says so when the working tree is clean', async () => {
      seedHistory(repo)
      const result = await call(repo, 'git_status')
      expect(result.isError).toBe(false)
      expect(result.text).toContain('On branch trunk')
      expect(result.text).toContain('Working tree clean')
    })

    it('shows renames as old to new', async () => {
      seedHistory(repo)
      git(repo, 'mv', 'a.txt', 'c.txt')
      expect((await call(repo, 'git_status')).text).toMatch(/renamed\s+a\.txt -> c\.txt/)
    })

    it('reports the upstream with ahead and behind counts', async () => {
      const origin = join(root, 'origin')
      seedHistory(origin)
      git(root, 'clone', '-q', origin, join(root, 'clone'))
      const clone = join(root, 'clone')
      write(clone, 'local.txt', 'local')
      git(clone, 'add', 'local.txt')
      git(clone, 'commit', '-q', '-m', 'local')
      const result = await call(clone, 'git_status')
      expect(result.text).toContain('tracking origin/trunk')
      expect(result.text).toContain('ahead 1')
    })

    it('shows file names with spaces and non-ASCII characters as they are', async () => {
      seedHistory(repo)
      write(repo, 'café ☕.txt', 'x\n')
      write(repo, '日本語/ファイル.txt', 'y\n')
      git(repo, 'add', '-N', '.')
      const status = await call(repo, 'git_status')
      expect(status.text).toContain('café ☕.txt')
      expect(status.text).toContain('日本語/ファイル.txt')
      const diff = await call(repo, 'git_diff', { path: 'café ☕.txt' })
      expect(diff.isError).toBe(false)
      expect(diff.text).toContain('café ☕.txt')
      expect(diff.text).toContain('+x')
    })

    it('reports an unborn branch', async () => {
      initRepo(repo)
      write(repo, 'new.txt', 'x')
      expect((await call(repo, 'git_status')).text).toContain('No commits yet on trunk')
    })

    it('describes a detached HEAD', async () => {
      seedHistory(repo)
      git(repo, 'checkout', '-q', '--detach')
      expect((await call(repo, 'git_status')).text).toMatch(/HEAD detached at [0-9a-f]{7,}/)
    })

    it('limits very long lists and keeps the count', async () => {
      seedHistory(repo)
      for (let index = 0; index < 130; index++) write(repo, `many/file-${index}.txt`, 'x')
      git(repo, 'add', '-N', 'many')
      const result = await call(repo, 'git_status')
      expect(result.text).toContain('Unstaged changes (130):')
      expect(result.text).toMatch(/and 30 more/)
    })

    it('fails clearly outside a repository', async () => {
      const plain = join(root, 'plain')
      mkdirSync(plain)
      const result = await call(plain, 'git_status')
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/not a git repository/i)
      expect((await call(join(root, 'missing'), 'git_status')).isError).toBe(true)
    })

    it('reports a missing git program plainly', async () => {
      seedHistory(repo)
      // One name is enough: Windows treats PATH and Path as the same variable.
      vi.stubEnv('PATH', '')
      try {
        const result = await call(repo, 'git_status')
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/git was not found|could not start git/i)
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })

  describe('git_diff', () => {
    it('shows unstaged changes by default and staged changes on request', async () => {
      seedHistory(repo)
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'sub/b.txt', 'bee\nbuzz\n')
      git(repo, 'add', 'sub/b.txt')
      const unstaged = await call(repo, 'git_diff')
      expect(unstaged.isError).toBe(false)
      expect(unstaged.text).toContain('+four')
      expect(unstaged.text).not.toContain('+buzz')
      const staged = await call(repo, 'git_diff', { staged: true })
      expect(staged.text).toContain('+buzz')
      expect(staged.text).not.toContain('+four')
    })

    it('compares the working tree against a base revision', async () => {
      seedHistory(repo)
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      const result = await call(repo, 'git_diff', { base: 'HEAD~1' })
      expect(result.text).toContain('+three')
      expect(result.text).toContain('+four')
    })

    it('limits the diff to one path', async () => {
      seedHistory(repo)
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'sub/b.txt', 'bee\nbuzz\n')
      const result = await call(repo, 'git_diff', { path: 'sub' })
      expect(result.text).toContain('+buzz')
      expect(result.text).not.toContain('+four')
    })

    it('says when there is nothing to show', async () => {
      seedHistory(repo)
      const result = await call(repo, 'git_diff')
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(/no unstaged changes/i)
      expect((await call(repo, 'git_diff', { staged: true })).text).toMatch(/no staged changes/i)
    })

    it('caps large diffs near 60 KB with a truncation notice', async () => {
      seedHistory(repo)
      const lines = (word: string, count: number): string => Array.from({ length: count }, (_, index) => `${word} number ${index} with padding`).join('\n') + '\n'
      write(repo, 'big.txt', lines('line', 6000))
      git(repo, 'add', 'big.txt')
      git(repo, 'commit', '-q', '-m', 'big')
      write(repo, 'big.txt', lines('LINE', 6000))
      const result = await call(repo, 'git_diff')
      expect(result.isError).toBe(false)
      expect(Buffer.byteLength(result.text)).toBeLessThan(64 * 1024)
      expect(Buffer.byteLength(result.text)).toBeGreaterThan(50 * 1024)
      expect(result.text).toMatch(/output truncated/i)
      expect(result.text).toContain('big.txt')
    })

    it('survives a diff far larger than the capture limit', async () => {
      seedHistory(repo)
      const lines = (word: string, count: number): string => Array.from({ length: count }, (_, index) => `${word} number ${index} with padding text`).join('\n') + '\n'
      write(repo, 'huge.txt', lines('line', 40_000))
      git(repo, 'add', 'huge.txt')
      git(repo, 'commit', '-q', '-m', 'huge')
      write(repo, 'huge.txt', lines('LINE', 40_000))
      const result = await call(repo, 'git_diff')
      expect(result.isError).toBe(false)
      expect(Buffer.byteLength(result.text)).toBeLessThan(64 * 1024)
      expect(result.text).toMatch(/output truncated/i)
    })

    it('validates its inputs', async () => {
      seedHistory(repo)
      expect((await call(repo, 'git_diff', { staged: 'yes' })).isError).toBe(true)
      expect((await call(repo, 'git_diff', { base: '--stat' })).isError).toBe(true)
      expect((await call(repo, 'git_diff', { base: 'no-such-revision' })).isError).toBe(true)
      expect((await call(repo, 'git_diff', { path: 7 })).isError).toBe(true)
      expect((await call(repo, 'git_diff', 'nope' as unknown as JSONValue)).isError).toBe(true)
    })
  })

  describe('git_log', () => {
    it('lists recent commits and limits them with max', async () => {
      seedHistory(repo)
      const all = await call(repo, 'git_log')
      expect(all.isError).toBe(false)
      expect(all.text).toContain('Add a third line')
      expect(all.text).toContain('Add files')
      expect(all.text).toContain('Cubex Test')
      const one = await call(repo, 'git_log', { max: 1 })
      expect(one.text).toContain('Add a third line')
      expect(one.text).not.toContain('Add files')
    })

    it('filters by path', async () => {
      seedHistory(repo)
      write(repo, 'sub/b.txt', 'bee\nbuzz\n')
      git(repo, 'commit', '-q', '-am', 'Touch b')
      const result = await call(repo, 'git_log', { path: 'sub/b.txt' })
      expect(result.text).toContain('Touch b')
      expect(result.text).toContain('Add files')
      expect(result.text).not.toContain('Add a third line')
    })

    it('never returns more than 50 commits', async () => {
      initRepo(repo)
      fastImportCommits(repo, 55)
      const result = await call(repo, 'git_log', { max: 500 })
      expect(result.isError).toBe(false)
      expect(result.text.match(/^[0-9a-f]{7,} /gm)).toHaveLength(50)
      expect(result.text).toContain('commit number 55')
      expect(result.text).not.toContain('commit number 5\n')
    })

    it('reports an unborn branch', async () => {
      initRepo(repo)
      expect((await call(repo, 'git_log')).isError).toBe(true)
    })

    it('validates max', async () => {
      seedHistory(repo)
      for (const max of [0, -1, 1.5, '5']) expect((await call(repo, 'git_log', { max: max as JSONValue })).isError).toBe(true)
      expect((await call(repo, 'git_log', { max: null, path: null })).isError).toBe(false)
    })
  })

  describe('git_show', () => {
    it('shows a commit with its changes, optionally for one path', async () => {
      seedHistory(repo)
      const head = await call(repo, 'git_show', { rev: 'HEAD' })
      expect(head.isError).toBe(false)
      expect(head.text).toContain('Add a third line')
      expect(head.text).toContain('+three')
      const first = await call(repo, 'git_show', { rev: 'HEAD~1', path: 'sub/b.txt' })
      expect(first.text).toContain('+bee')
      expect(first.text).not.toContain('+one')
    })

    it('reports unknown revisions', async () => {
      seedHistory(repo)
      const result = await call(repo, 'git_show', { rev: 'no-such-revision' })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/unknown revision|bad revision|ambiguous/i)
    })

    it('accepts the usual revision expressions', async () => {
      seedHistory(repo)
      for (const rev of ['HEAD^', 'HEAD~1', 'HEAD@{0}', 'trunk', 'HEAD^{commit}', 'trunk~1^0', 'HEAD~1..HEAD']) {
        const result = await call(repo, 'git_show', { rev })
        expect(result.isError, rev).toBe(false)
      }
    })

    it('does not accept the rev:path form, so file reads stay in the file tools', async () => {
      seedHistory(repo)
      const result = await call(repo, 'git_show', { rev: 'HEAD:a.txt' })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/path/i)
    })
  })

  describe('git_blame', () => {
    it('attributes lines and honours a line range', async () => {
      seedHistory(repo)
      const all = await call(repo, 'git_blame', { path: 'a.txt' })
      expect(all.isError).toBe(false)
      expect(all.text).toMatch(/\(Cubex Test .*\b3\) three/)
      expect(all.text).toContain('one')
      const range = await call(repo, 'git_blame', { path: 'a.txt', startLine: 3, endLine: 3 })
      expect(range.text).toContain('three')
      expect(range.text).not.toContain('one')
      const tail = await call(repo, 'git_blame', { path: 'a.txt', startLine: 2 })
      expect(tail.text).toContain('two')
      expect(tail.text).not.toContain('one')
    })

    it('validates the range and the path', async () => {
      seedHistory(repo)
      expect((await call(repo, 'git_blame', { path: 'a.txt', startLine: 0 })).isError).toBe(true)
      expect((await call(repo, 'git_blame', { path: 'a.txt', startLine: 3, endLine: 2 })).isError).toBe(true)
      expect((await call(repo, 'git_blame', { path: 'a.txt', startLine: 1.5 })).isError).toBe(true)
      expect((await call(repo, 'git_blame', {})).isError).toBe(true)
      expect((await call(repo, 'git_blame', { path: '.' })).isError).toBe(true)
      write(repo, 'untracked.txt', 'x')
      expect((await call(repo, 'git_blame', { path: 'untracked.txt' })).isError).toBe(true)
    })
  })

  describe('paths and revisions from the model', () => {
    const readers: Array<[string, (path: string) => JSONValue]> = [
      ['git_diff', (path) => ({ path })],
      ['git_log', (path) => ({ path })],
      ['git_show', (path) => ({ rev: 'HEAD', path })],
      ['git_blame', (path) => ({ path })]
    ]

    it.each(readers)('%s refuses paths outside the workspace', async (name, input) => {
      seedHistory(repo)
      write(root, 'outside.txt', 'secret')
      for (const path of ['../outside.txt', join(root, 'outside.txt'), '..', 'sub/../../outside.txt', '\\\\server\\share\\x']) {
        const result = await call(repo, name, input(path))
        expect(result.isError, `${name} ${path}`).toBe(true)
        expect(result.text, `${name} ${path}`).toMatch(/outside the workspace|escapes the workspace|network path/i)
      }
    })

    it.each(readers)('%s refuses a link that leads out of the workspace', async (name, input) => {
      seedHistory(repo)
      write(root, 'outside-dir/secret.txt', 'secret')
      const link = join(repo, 'link')
      try {
        symlinkSync(join(root, 'outside-dir'), link, 'junction')
      } catch { return } // Creating links needs a privilege on some systems.
      try {
        const result = await call(repo, name, input('link/secret.txt'))
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/outside the workspace|escapes the workspace/i)
      } finally {
        dropLink(link)
      }
    })

    it.each(readers)('%s refuses git internals and pathspec magic', async (name, input) => {
      seedHistory(repo)
      for (const path of ['.git/config', '.git', ':(top)a.txt', ':/', ':(glob)**', 'a.txt:stream']) {
        const result = await call(repo, name, input(path))
        expect(result.isError, `${name} ${path}`).toBe(true)
      }
    })

    it('treats glob characters in a path literally', async () => {
      seedHistory(repo)
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      write(repo, 'sub/b.txt', 'bee\nbuzz\n')
      const result = await call(repo, 'git_diff', { path: '*.txt' })
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(/no unstaged changes/i)
      // Brackets are legal in file names on every platform and are glob syntax: a.txt must not match a[.]txt.
      const brackets = await call(repo, 'git_diff', { path: 'a[.]txt' })
      expect(brackets.isError).toBe(false)
      expect(brackets.text).toMatch(/no unstaged changes/i)
    })

    it('does not let a revision become an option', async () => {
      seedHistory(repo)
      const target = join(repo, 'pwned.txt')
      for (const rev of ['--output=pwned.txt', '-p', '--exec=sh', ' HEAD', 'HEAD ', 'HEAD\n--output=pwned.txt', '--']) {
        const result = await call(repo, 'git_show', { rev })
        expect(result.isError, JSON.stringify(rev)).toBe(true)
      }
      expect((await call(repo, 'git_diff', { base: '--output=pwned.txt' })).isError).toBe(true)
      expect(existsSync(target)).toBe(false)
    })

    it('does not let a path become an option', async () => {
      seedHistory(repo)
      const result = await call(repo, 'git_diff', { path: '--output=pwned.txt' })
      expect(result.isError).toBe(false)
      expect(existsSync(join(repo, 'pwned.txt'))).toBe(false)
      expect((await call(repo, 'git_log', { path: '--output=pwned.txt' })).isError).toBe(false)
      expect(existsSync(join(repo, 'pwned.txt'))).toBe(false)
    })

    it('reads through a path that no longer exists on disk', async () => {
      seedHistory(repo)
      rmSync(join(repo, 'sub', 'b.txt'))
      const diff = await call(repo, 'git_diff', { path: 'sub/b.txt' })
      expect(diff.isError).toBe(false)
      expect(diff.text).toContain('-bee')
      expect((await call(repo, 'git_log', { path: 'sub/b.txt' })).text).toContain('Add files')
    })
  })

  describe('repository configuration', () => {
    it('never runs a program that the repository configures for status, diff, show, log or blame', async () => {
      seedHistory(repo)
      const { script, ran } = writeProbe(root)
      git(repo, 'config', 'core.fsmonitor', `"${script}"`)
      git(repo, 'config', 'diff.external', `"${script}"`)
      git(repo, 'config', 'diff.probe.textconv', `"${script}"`)
      write(repo, '.gitattributes', '*.txt diff=probe\n')
      git(repo, 'add', '.gitattributes')
      git(repo, 'commit', '-q', '-m', 'attributes')
      write(repo, 'a.txt', 'one\ntwo\nthree\nfour\n')
      // Setting up ran git too (a commit consults fsmonitor); only the tools are under test.
      rmSync(ran, { force: true })

      for (const [name, input] of [
        ['git_status', {}], ['git_diff', {}], ['git_diff', { staged: true }], ['git_show', { rev: 'HEAD' }], ['git_show', { rev: 'HEAD~2', path: 'a.txt' }],
        ['git_log', {}], ['git_blame', { path: 'a.txt' }]
      ] as Array<[string, JSONValue]>) {
        await call(repo, name, input)
        expect(existsSync(ran), `${name} ran a configured program`).toBe(false)
      }
      // Control: plain git does run them, so the assertions above are what held them back.
      git(repo, 'diff')
      expect(existsSync(ran)).toBe(true)
    })

    it('declines to hash files through a repository-defined filter, but still reads history', async () => {
      seedHistory(repo)
      const { script, ran } = writeProbe(root)
      git(repo, 'config', 'filter.probe.clean', `"${script}"`)
      write(repo, '.gitattributes', '*.txt filter=probe\n')
      // Same size, new content: git would have to run the clean filter to compare it.
      write(repo, 'a.txt', 'one\ntwo\nTHREE\n')

      for (const [name, input] of [['git_status', {}], ['git_diff', {}], ['git_diff', { base: 'HEAD~1' }], ['git_blame', { path: 'a.txt' }]] as Array<[string, JSONValue]>) {
        const result = await call(repo, name, input)
        expect(existsSync(ran), `${name} ran the filter`).toBe(false)
        if (name === 'git_status') expect(result.text).toMatch(/On branch trunk/)
        expect(result.text, name).toMatch(/filter/i)
      }
      expect((await call(repo, 'git_log')).text).toContain('Add a third line')
      expect((await call(repo, 'git_show', { rev: 'HEAD' })).isError).toBe(false)
      expect((await call(repo, 'git_diff', { staged: true })).isError).toBe(false)
      expect(existsSync(ran)).toBe(false)
      // Control: plain git does run it.
      git(repo, 'status', '--porcelain')
      expect(existsSync(ran)).toBe(true)
    })

    it('does not read outside the workspace when the repository redirects its working tree', async () => {
      seedHistory(repo)
      // The same name as a tracked file, so a diff or blame would print the outside file's lines.
      write(root, 'victim/a.txt', 'TOP-SECRET-1\nTOP-SECRET-2\n')
      git(repo, 'config', 'core.worktree', posix(join(root, 'victim')))
      for (const [name, input] of [
        ['git_status', {}], ['git_diff', {}], ['git_diff', { base: 'HEAD~1' }], ['git_blame', { path: 'a.txt' }]
      ] as Array<[string, JSONValue]>) {
        const result = await call(repo, name, input)
        expect(result.text, name).not.toContain('TOP-SECRET')
        expect(result.text, name).toMatch(/working tree/i)
      }
      // Reading history never looks at the working tree.
      expect((await call(repo, 'git_log')).text).toContain('Add a third line')
      expect((await call(repo, 'git_diff', { staged: true })).isError).toBe(false)
    })

    it('accepts a core.worktree that points back at the workspace, as separate git directories do', async () => {
      const separate = join(root, 'separate-git-dir')
      mkdirSync(repo)
      git(repo, 'init', '-q', `--separate-git-dir=${separate}`)
      git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')
      write(repo, 'a.txt', 'one\n')
      git(repo, 'add', 'a.txt')
      git(repo, 'commit', '-q', '-m', 'first')
      // Some git versions write this themselves; the guard must accept it when it names the workspace.
      git(repo, 'config', 'core.worktree', posix(repo))
      write(repo, 'a.txt', 'one\ntwo\n')
      const status = await call(repo, 'git_status')
      expect(status.isError).toBe(false)
      expect(status.text).toMatch(/modified\s+a\.txt/)
      expect((await call(repo, 'git_diff')).text).toContain('+two')
    })

    it('refuses blame when the repository names an ignore-revs file outside the workspace', async () => {
      seedHistory(repo)
      write(root, 'secret.env', 'AWS_SECRET_ACCESS_KEY=hunter2hunter2\n')
      for (const value of [posix(join(root, 'secret.env')), '~/secret.env', '../secret.env', '%(prefix)/secret.env']) {
        git(repo, 'config', 'blame.ignoreRevsFile', value)
        const result = await call(repo, 'git_blame', { path: 'a.txt' })
        expect(result.isError, value).toBe(true)
        expect(result.text, value).not.toContain('hunter2')
        expect(result.text, value).toMatch(/ignoreRevsFile/i)
      }
    })

    it('still blames when the ignore-revs file is inside the workspace', async () => {
      seedHistory(repo)
      write(repo, '.git-blame-ignore-revs', `${git(repo, 'rev-parse', 'HEAD').trim()}\n`)
      git(repo, 'config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs')
      const result = await call(repo, 'git_blame', { path: 'a.txt' })
      expect(result.isError).toBe(false)
      expect(result.text).toContain('three')
    })

    it('ignores an inherited repository override in the environment', async () => {
      seedHistory(repo)
      const other = join(root, 'other')
      initRepo(other)
      vi.stubEnv('GIT_DIR', join(other, '.git'))
      vi.stubEnv('GIT_WORK_TREE', other)
      vi.stubEnv('GIT_INDEX_FILE', join(other, 'index'))
      try {
        expect((await call(repo, 'git_log')).text).toContain('Add a third line')
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it.skipIf(process.platform !== 'win32')('refuses to run a git program planted in the workspace', async () => {
      seedHistory(repo)
      write(repo, 'git.bat', '@echo off\r\necho planted > planted.txt\r\n')
      for (const name of ['git_status', 'git_log']) {
        const result = await call(repo, name)
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/git/i)
      }
      expect(existsSync(join(repo, 'planted.txt'))).toBe(false)
    })
  })
})
