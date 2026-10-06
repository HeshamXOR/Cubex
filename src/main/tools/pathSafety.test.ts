import { afterAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { createFileTools } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

/**
 * Path-guard review of every path-taking tool (read, write, edit, multi_edit, remove,
 * list, glob, search, apply_patch). Windows-specific spellings are skipped elsewhere,
 * because only Win32 path handling gives those names their meaning.
 */

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
const onWindows = process.platform === 'win32'
const windowsOnly = describe.skipIf(!onWindows)
// Created at load time because the it.each tables below are evaluated during collection.
const base = mkdtempSync(join(tmpdir(), 'cubex-paths-'))
const root = join(base, 'ws')
const outside = join(base, 'ws-evil')
mkdirSync(root)
mkdirSync(outside)
writeFileSync(join(outside, 'secret.txt'), 'top secret')
writeFileSync(join(root, 'a.txt'), 'a')
writeFileSync(join(root, 'foo'), 'inside foo')
mkdirSync(join(root, 'sub'))
writeFileSync(join(root, 'sub', 'x.txt'), 'x')
afterAll(() => rmSync(base, { recursive: true, force: true }))

type Tools = ReturnType<typeof createFileTools>
const named = (tools: Tools, name: string) => tools.find((item) => item.definition.name === name)!

/** Every path-taking call, phrased for one path. Edits arrive as complete valid calls so only the path can be at fault. */
const CALLS: Array<{ label: string; tool: string; input: (path: string) => JSONValue }> = [
  { label: 'read_file', tool: 'read_file', input: (path) => ({ path }) },
  { label: 'read_file (paged)', tool: 'read_file', input: (path) => ({ path, offset: 1, limit: 5 }) },
  { label: 'list_files', tool: 'list_files', input: (path) => ({ path }) },
  { label: 'glob_files', tool: 'glob_files', input: (path) => ({ pattern: '*', path }) },
  { label: 'search_files', tool: 'search_files', input: (path) => ({ query: 'x', path }) },
  { label: 'write_file', tool: 'write_file', input: (path) => ({ path, content: 'pwned' }) },
  { label: 'edit_file', tool: 'edit_file', input: (path) => ({ path, old_string: 'a', new_string: 'b' }) },
  { label: 'multi_edit', tool: 'multi_edit', input: (path) => ({ path, edits: [{ old_string: 'a', new_string: 'b' }] }) },
  { label: 'remove_file', tool: 'remove_file', input: (path) => ({ path }) },
  { label: 'apply_patch add', tool: 'apply_patch', input: (path) => ({ patch: `*** Begin Patch\n*** Add File: ${path}\n+pwned\n*** End Patch` }) },
  { label: 'apply_patch update', tool: 'apply_patch', input: (path) => ({ patch: `*** Begin Patch\n*** Update File: ${path}\n-a\n+b\n*** End Patch` }) },
  { label: 'apply_patch delete', tool: 'apply_patch', input: (path) => ({ patch: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` }) },
  { label: 'apply_patch move', tool: 'apply_patch', input: (path) => ({ patch: `*** Begin Patch\n*** Update File: a.txt\n*** Move to: ${path}\n*** End Patch` }) }
]
// A path with trailing whitespace is trimmed by the patch parser itself, so it is never what apply_patch resolves.
const patchTrimsPaths = (label: string): boolean => label.startsWith('apply_patch')

async function attempt(call: (typeof CALLS)[number], path: string): Promise<{ isError: boolean; text: string }> {
  const tools = createFileTools(root)
  const result = await named(tools, call.tool).execute(call.input(path), ctx)
  return { isError: result.isError === true, text: String(result.content) }
}

/** Run every call against one path and require each to be rejected with a message matching `expected`. */
async function expectAllRejected(path: string, expected: RegExp, skip: (label: string) => boolean = () => false): Promise<void> {
  for (const call of CALLS) {
    if (skip(call.label)) continue
    const { isError, text } = await attempt(call, path)
    expect(isError, `${call.label} accepted ${JSON.stringify(path)}`).toBe(true)
    expect(text, `${call.label} rejected ${JSON.stringify(path)} for the wrong reason`).toMatch(expected)
  }
}

const otherDrive = ((): string => {
  const mine = parse(root || tmpdir()).root[0]!.toUpperCase()
  return ['Z', 'Y', 'X', 'W', 'V'].find((letter) => letter !== mine) ?? 'Z'
})()

describe('escaping the workspace (every platform)', () => {
  it.each([
    ['a parent reference', '../ws-evil/secret.txt'],
    ['a parent reference after normalization', 'sub/../../ws-evil/secret.txt'],
    ['a deep chain of parent references', 'sub/../sub/../../../x.txt'],
    ['a sibling directory sharing the workspace name as a prefix', '../ws-evil'],
    ['an absolute path outside', join(outside, 'secret.txt')],
    ['the filesystem root', parse(root).root],
    ...(onWindows ? [['backslash parent references', '..\\ws-evil\\secret.txt']] : [])
  ] as Array<[string, string]>)('rejects %s from every tool', async (_label, path) => {
    await expectAllRejected(path, /escapes the workspace/i)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
  })

  it('still allows paths inside the workspace, including absolute ones and different spellings of the same file', async () => {
    const tools = createFileTools(root)
    for (const path of ['a.txt', './a.txt', 'sub/../a.txt', join(root, 'a.txt'), 'sub/./../a.txt']) {
      const result = await named(tools, 'read_file').execute({ path }, ctx)
      expect(result.isError, path).toBeFalsy()
      expect(result.content).toBe('a')
    }
  })
})

windowsOnly('Windows path spellings that leave the workspace', () => {
  it.each([
    ['a UNC path', '\\\\server\\share\\x.txt'],
    ['a UNC path with forward slashes', '//server/share/x.txt'],
    ['an extended-length path', '\\\\?\\C:\\Windows\\win.ini'],
    ['a device-namespace path', '\\\\.\\C:\\Windows\\win.ini'],
    ['an extended-length UNC path', '\\\\?\\UNC\\server\\share\\x'],
    ['a rooted path without a drive', '\\Windows\\win.ini'],
    ['a drive-relative path on another drive', `${otherDrive}:foo`],
    ['an absolute path on another drive', `${otherDrive}:\\foo`]
  ])('rejects %s from every tool', async (_label, path) => {
    await expectAllRejected(path, /escapes the workspace/i)
  })

  it('treats a drive-relative path on the workspace drive as a path inside the workspace, never the drive working directory', async () => {
    const tools = createFileTools(root)
    const drive = parse(root).root.slice(0, 2)
    const result = await named(tools, 'read_file').execute({ path: `${drive}foo` }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('inside foo')
  })

  it('compares paths case-insensitively and does not confuse a prefix-sharing sibling for the workspace', async () => {
    const shouty = createFileTools(root.toUpperCase())
    expect((await named(shouty, 'read_file').execute({ path: 'a.txt' }, ctx)).content).toBe('a')
    expect((await named(shouty, 'read_file').execute({ path: join(root, 'A.TXT') }, ctx)).content).toBe('a')
    const result = await named(shouty, 'read_file').execute({ path: join(outside, 'secret.txt') }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/escapes the workspace/i)
  })
})

windowsOnly('names Windows treats specially', () => {
  const superscriptOne = String.fromCharCode(0xb9)
  it.each([
    ['a device name', 'CON'],
    ['a lower-case device name', 'nul'],
    ['a numbered port', 'COM1'],
    ['a printer port', 'LPT1'],
    ['a device name with an extension', 'aux.txt'],
    ['a device name inside a folder', 'sub/PRN.md'],
    ['a device name as a folder', 'sub/COM3/x.txt'],
    ['a device name followed by spaces before the extension', 'nul .txt'],
    ['a device name with a trailing dot', 'con.'],
    ['a console buffer device', 'CONIN$'],
    ['a superscript port number', `COM${superscriptOne}`]
  ])('rejects %s from every tool', async (_label, path) => {
    await expectAllRejected(path, /reserved windows device name/i)
  })

  it('does not mistake names that merely contain a device name', async () => {
    const tools = createFileTools(root)
    for (const name of ['console.txt', 'nullable.ts', 'com10.txt', 'auxiliary.md', 'lpt.txt', 'a.con']) {
      const result = await named(tools, 'write_file').execute({ path: `ok-${name}`, content: 'fine' }, ctx)
      expect(result.isError, name).toBeFalsy()
    }
  })
})

windowsOnly('NTFS alternate data streams', () => {
  it.each([
    ['a named stream on a file', 'a.txt:hidden'],
    ['the default stream spelled out', 'a.txt::$DATA'],
    ['a stream with a type', 'a.txt:hidden:$DATA'],
    ['a directory stream alias', 'sub::$INDEX_ALLOCATION/x.txt'],
    ['a stream on a folder component', 'sub:stream/x.txt'],
    ['a stream used to spell .git', '.git::$INDEX_ALLOCATION/config']
  ])('rejects %s from every tool', async (_label, path) => {
    await expectAllRejected(path, /alternate data stream/i)
  })

  it('never creates a hidden stream', async () => {
    const tools = createFileTools(root)
    await named(tools, 'write_file').execute({ path: 'a.txt:payload', content: 'hidden' }, ctx)
    expect(() => readFileSync(join(root, 'a.txt:payload'))).toThrow()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a')
  })
})

windowsOnly('trailing dots and spaces, and characters Windows forbids', () => {
  it.each([
    ['a trailing dot', 'a.txt.'],
    ['trailing dots', 'a.txt..'],
    ['a folder with a trailing dot', 'sub./x.txt'],
    ['a trailing dot on .git', '.git./config'],
    ['a folder with a trailing space', 'sub /x.txt'],
    ['an empty-looking name made of dots', 'sub/...']
  ])('rejects %s from every tool', async (_label, path) => {
    await expectAllRejected(path, /ends in a dot or space/i)
  })

  it('rejects a trailing space in a path argument (a patch header trims it itself)', async () => {
    await expectAllRejected('a.txt ', /ends in a dot or space/i, patchTrimsPaths)
  })

  it.each([
    ['a question mark', 'a?.txt'],
    ['an asterisk', 'a*.txt'],
    ['an angle bracket', 'a<b.txt'],
    ['a pipe', 'a|b.txt'],
    ['a double quote', 'a"b.txt']
  ])('rejects %s from every tool with a clear message', async (_label, path) => {
    await expectAllRejected(path, /not allowed in a windows path/i)
  })
})

windowsOnly('8.3 short names', () => {
  function shortAlias(dir: string): string | undefined {
    try {
      const short = execSync(`for %I in ("${dir}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf8' }).trim()
      return short && short.toLowerCase() !== dir.toLowerCase() ? basename(short) : undefined
    } catch { return undefined }
  }

  it('rejects the short alias of a folder, including an alias of .git, from every tool', async (context) => {
    const long = 'protected-folder-with-a-long-name'
    mkdirSync(join(root, long), { recursive: true })
    writeFileSync(join(root, long, 'file.txt'), 'a')
    const alias = shortAlias(join(root, long))
    if (!alias) return context.skip()
    await expectAllRejected(`${alias}/file.txt`, /short \(8\.3\) (name|alias)/i)
    // The same spelling would otherwise reach .git without matching the protected-path rule.
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    const gitAlias = shortAlias(join(root, '.git'))
    if (!gitAlias) return
    await expectAllRejected(`${gitAlias}/hooks/pre-commit`, /short \(8\.3\) (name|alias)/i)
    expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('accepts a real file whose name happens to look like an alias', async () => {
    const tools = createFileTools(root)
    writeFileSync(join(root, 'notes~1.txt'), 'real')
    const result = await named(tools, 'read_file').execute({ path: 'notes~1.txt' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('real')
  })

  it('rejects look-alike spellings of a real name that Windows would still resolve to it', async () => {
    mkdirSync(join(root, '.cubex'), { recursive: true })
    writeFileSync(join(root, '.cubex', 'settings.json'), '{}')
    // U+0131 (dotless i) folds to I in NTFS case mapping but not in JavaScript's case-insensitive matching.
    const lookalike = `.g${String.fromCharCode(0x131)}t`
    mkdirSync(join(root, '.git'), { recursive: true })
    const tools = createFileTools(root)
    const result = await named(tools, 'write_file').execute({ path: `${lookalike}/config`, content: 'x' }, ctx)
    // Whether or not this volume folds it, the file must not appear under .git.
    expect(existsSync(join(root, '.git', 'config'))).toBe(false)
    if (!result.isError) rmSync(join(root, lookalike), { recursive: true, force: true })
  })
})

describe('links and junctions on any component', () => {
  const dirLink = onWindows ? 'junction' : 'dir'
  let links: string[] = []
  const link = (target: string, path: string): boolean => {
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      symlinkSync(target, path, dirLink)
      links.push(path)
      return true
    } catch { return false }
  }
  // Links go before their targets: a junction whose target is gone cannot be removed on Windows.
  const cleanLinks = (): void => { for (const path of links.reverse()) rmSync(path, { recursive: true, force: true }); links = [] }

  it('rejects a link to a folder outside the workspace as a middle component, for every tool', async (context) => {
    if (!link(outside, join(root, 'links', 'exit'))) return context.skip()
    try {
      await expectAllRejected('links/exit/secret.txt', /escapes the workspace/i)
      await expectAllRejected('links/exit', /escapes the workspace/i)
      await expectAllRejected('links/exit/new.txt', /escapes the workspace/i)
      expect(existsSync(join(outside, 'new.txt'))).toBe(false)
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
    } finally { cleanLinks() }
  })

  it('rejects a link to a folder outside the workspace nested several levels down', async (context) => {
    if (!link(outside, join(root, 'deep', 'er', 'exit'))) return context.skip()
    try {
      await expectAllRejected('deep/er/exit/secret.txt', /escapes the workspace/i)
    } finally { cleanLinks() }
  })

  it('still allows a link that stays inside the workspace', async (context) => {
    if (!link(join(root, 'sub'), join(root, 'links', 'inner'))) return context.skip()
    try {
      const tools = createFileTools(root)
      const result = await named(tools, 'read_file').execute({ path: 'links/inner/x.txt' }, ctx)
      expect(result.isError).toBeFalsy()
      expect(result.content).toBe('x')
    } finally { cleanLinks() }
  })

  it('does not reach a protected folder through a link: the real location is checked, not just the spelling', async (context) => {
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), '[core]')
    if (!link(join(root, '.git'), join(root, 'innocent'))) return context.skip()
    try {
      const tools = createFileTools(root)
      for (const call of CALLS.filter((item) => /^(write_file|edit_file|multi_edit|remove_file|apply_patch)/.test(item.label))) {
        const result = await named(tools, call.tool).execute(call.input('innocent/hooks/pre-commit'), ctx)
        expect(result.isError, call.label).toBe(true)
        expect(String(result.content), call.label).toMatch(/protected/i)
      }
      expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(false)
      // Reading through the link is harmless and unchanged.
      expect((await named(tools, 'read_file').execute({ path: 'innocent/config' }, ctx)).content).toBe('[core]')
    } finally { cleanLinks() }
  })

  it('refuses to write through a dangling link that points outside the workspace', async (context) => {
    const missing = join(outside, 'not-yet-created')
    const path = join(root, 'dangling')
    try { symlinkSync(missing, path, 'file') } catch { return context.skip() }
    try {
      const tools = createFileTools(root)
      const result = await named(tools, 'write_file').execute({ path: 'dangling', content: 'pwned' }, ctx)
      expect(result.isError).toBe(true)
      expect(existsSync(missing)).toBe(false)
      const patch = await named(tools, 'apply_patch').execute({ patch: '*** Begin Patch\n*** Add File: dangling\n+pwned\n*** End Patch' } as JSONValue, ctx)
      expect(patch.isError).toBe(true)
      expect(existsSync(missing)).toBe(false)
    } finally { rmSync(path, { force: true }) }
  })

  it('refuses to write through a link to a file outside the workspace', async (context) => {
    const path = join(root, 'file-link')
    try { symlinkSync(join(outside, 'secret.txt'), path, 'file') } catch { return context.skip() }
    try {
      const tools = createFileTools(root)
      await named(tools, 'read_file').execute({ path: 'file-link' }, ctx)
      for (const call of CALLS.filter((item) => /^(write_file|edit_file|multi_edit)/.test(item.label))) {
        const result = await named(tools, call.tool).execute(call.input('file-link'), ctx)
        expect(result.isError, call.label).toBe(true)
      }
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
    } finally { rmSync(path, { force: true }) }
  })
})

describe('listing results never name entries the guard would refuse', () => {
  it('does not surface anything from outside the workspace through list, glob or search', async () => {
    const tools = createFileTools(root)
    const listed = String((await named(tools, 'list_files').execute({ path: '.' }, ctx)).content)
    const found = String((await named(tools, 'glob_files').execute({ pattern: '**/*' }, ctx)).content)
    const searched = String((await named(tools, 'search_files').execute({ query: 'top secret' }, ctx)).content)
    for (const text of [listed, found, searched]) expect(text).not.toContain('secret.txt')
    // The search report echoes the query, so assert on a hit line (path:line) rather than the words.
    expect(searched).not.toMatch(/secret\.txt:\d+/)
    expect(readdirSync(root)).toContain('a.txt')
  })
})
