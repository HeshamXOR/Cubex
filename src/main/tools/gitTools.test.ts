import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JSONValue, ToolExecutionContext } from '@core/types'
import { createGitTools } from './gitTools'
import { git, hasGit, initRepo, posix, seedHistory as buildHistory, write, writeProbe } from './gitTestHelpers'

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

    it('fails clearly outside a repository', async () => {
      const plain = join(root, 'plain')
      mkdirSync(plain)
      const result = await call(plain, 'git_status')
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/not a git repository/i)
      expect((await call(join(root, 'missing'), 'git_status')).isError).toBe(true)
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
