import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clipInput, describeTool, oneLine, patternBase, readCurrentFile, resultText } from './tools'

const cwd = resolve(tmpdir(), 'cubex-claude-tools-project')
const inside = (...parts: string[]): string => join(cwd, ...parts)
const describe1 = (name: string, input: Record<string, unknown>, readCurrent?: (path: string) => string | undefined) => describeTool(name, input, { cwd, ...(readCurrent ? { readCurrent } : {}) })

describe('reading', () => {
  it('names the file, relative to the project, and says where', () => {
    const info = describe1('Read', { file_path: inside('src', 'a.ts') })
    expect(info).toMatchObject({ title: 'Read src/a.ts', kind: 'read', locations: [{ path: inside('src', 'a.ts') }] })
  })

  it('reads a relative path against the project and keeps the line it starts at', () => {
    expect(describe1('Read', { file_path: 'src/a.ts', offset: 40 }).locations).toEqual([{ path: inside('src', 'a.ts'), line: 40 }])
    expect(describe1('Read', { file_path: 'src/a.ts', offset: -3 }).locations).toEqual([{ path: inside('src', 'a.ts') }])
  })

  it('shows the whole path of a file outside the project, so the person sees where it is', () => {
    const elsewhere = resolve(tmpdir(), 'cubex-claude-elsewhere', 'notes.txt')
    expect(describe1('Read', { file_path: elsewhere }).title).toBe(`Read ${elsewhere.replace(/\\/g, '/')}`)
  })

  it('does not make up a place for a call that names none', () => {
    const info = describe1('Read', {})
    expect(info.title).toBe('Read a file')
    expect(info.locations).toBeUndefined()
  })

  it('refuses a path with a null character as a place', () => {
    expect(describe1('Read', { file_path: 'a\u0000b' }).locations).toBeUndefined()
  })
})

describe('searching', () => {
  it('names the pattern and the folder it starts in', () => {
    expect(describe1('Grep', { pattern: 'TODO', path: 'src' })).toMatchObject({ title: 'Search for TODO', kind: 'search', locations: [{ path: inside('src') }] })
    expect(describe1('Grep', { pattern: 'TODO' }).locations).toBeUndefined()
  })

  it('leaves a pattern that stays below the folder to the folder it was started in', () => {
    expect(describe1('Glob', { pattern: 'src/**/*.ts' })).toMatchObject({ title: 'Find src/**/*.ts', kind: 'search' })
    expect(describe1('Glob', { pattern: 'src/**/*.ts' }).locations).toBeUndefined()
    expect(describe1('Glob', { pattern: '*.md', path: 'docs' }).locations).toEqual([{ path: inside('docs') }])
  })

  it('names the place a pattern climbs or points to, because that is where it searches', () => {
    expect(describe1('Glob', { pattern: '../*/secrets.txt' }).locations).toEqual([{ path: resolve(cwd, '..') }])
    const absolute = resolve(tmpdir(), 'cubex-claude-elsewhere')
    expect(describe1('Glob', { pattern: `${absolute.replace(/\\/g, '/')}/*.txt` }).locations).toEqual([{ path: absolute }])
    // Read against the folder it was told to start in, not the project.
    expect(describe1('Glob', { pattern: '../*.txt', path: 'docs' }).locations).toEqual([{ path: inside('docs') }, { path: resolve(inside('docs'), '..') }])
  })

  it('lists a folder', () => {
    expect(describe1('LS', { path: 'src' })).toMatchObject({ title: 'List src', kind: 'search', locations: [{ path: inside('src') }] })
  })
})

describe('where a pattern starts', () => {
  it.each([
    ['src/**/*.ts', 'src/'],
    ['*.ts', ''],
    ['a/b/c.txt', 'a/b/c.txt'],
    ['C:\\Users\\*\\x', 'C:\\Users\\'],
    ['../x/{a,b}', '../x/'],
    ['dir/file[12].txt', 'dir/'],
    ['**', '']
  ])('%s starts in %s', (pattern, base) => {
    expect(patternBase(pattern)).toBe(base)
  })
})

describe('changing files', () => {
  it('shows a new file as all new text', () => {
    const info = describe1('Write', { file_path: 'notes.txt', content: 'hello\n' }, () => undefined)
    expect(info).toMatchObject({ title: 'Write notes.txt', kind: 'edit', locations: [{ path: inside('notes.txt') }] })
    expect(info.content).toEqual([{ type: 'diff', path: inside('notes.txt'), oldText: null, newText: 'hello\n' }])
  })

  it('shows what a file holds now as the text it replaces', () => {
    const asked: string[] = []
    const info = describe1('Write', { file_path: 'notes.txt', content: 'new\n' }, (path) => { asked.push(path); return 'old\n' })
    expect(info.content).toEqual([{ type: 'diff', path: inside('notes.txt'), oldText: 'old\n', newText: 'new\n' }])
    expect(asked).toEqual([inside('notes.txt')])
  })

  it('shows an edit as the text it takes out and the text it puts in', () => {
    const info = describe1('Edit', { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' })
    expect(info).toMatchObject({ title: 'Edit src/a.ts', kind: 'edit' })
    expect(info.content).toEqual([{ type: 'diff', path: inside('src', 'a.ts'), oldText: 'one', newText: 'two' }])
  })

  it('shows several edits of one file, up to five', () => {
    const edits = Array.from({ length: 8 }, (_, index) => ({ old_string: `a${index}`, new_string: `b${index}` }))
    const info = describe1('MultiEdit', { file_path: 'src/a.ts', edits: [{ nonsense: true }, ...edits] })
    expect(info.kind).toBe('edit')
    expect(info.content).toHaveLength(5)
    expect(info.content?.[0]).toMatchObject({ oldText: 'a0', newText: 'b0' })
  })

  it('has no diff when the call carries no text, and still says where', () => {
    const info = describe1('Edit', { file_path: 'src/a.ts' })
    expect(info.content).toBeUndefined()
    expect(info.locations).toEqual([{ path: inside('src', 'a.ts') }])
  })

  it('names the notebook', () => {
    expect(describe1('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'x' })).toMatchObject({ title: 'Edit nb.ipynb', kind: 'edit', locations: [{ path: inside('nb.ipynb') }] })
  })

  it('keeps a change that names no file as an edit with no place, which the policy asks about and never allows by itself', () => {
    const info = describe1('Write', { content: 'x' })
    expect(info).toMatchObject({ title: 'Write a file', kind: 'edit' })
    expect(info.locations).toBeUndefined()
  })

  it('cuts a very large change before it is sent as a question', () => {
    const big = 'x'.repeat(200_000)
    const info = describe1('Write', { file_path: 'big.txt', content: big }, () => undefined)
    expect(info.content?.[0]?.newText).toHaveLength(60_000)
    expect(JSON.stringify(info.rawInput).length).toBeLessThan(5_000)
  })
})

describe('commands', () => {
  it('are of the kind that runs a command, whichever shell the program has', () => {
    expect(describe1('Bash', { command: 'npm test' })).toMatchObject({ title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } })
    expect(describe1('PowerShell', { command: 'Get-ChildItem' })).toMatchObject({ title: 'Run Get-ChildItem', kind: 'execute', rawInput: { command: 'Get-ChildItem' } })
  })

  it('make a title of one line, however many the command has', () => {
    const info = describe1('Bash', { command: `echo one\n\techo two\u0007\n${'x'.repeat(300)}` })
    expect(info.title).not.toMatch(/[\u0000-\u001f]/)
    expect(info.title.length).toBeLessThanOrEqual(124)
    expect(info.title.startsWith('Run echo one echo two x')).toBe(true)
    expect(info.title.endsWith('…')).toBe(true)
  })

  it('hand the policy the command whole, not cut to the title', () => {
    const command = `echo ${'y'.repeat(2_000)}`
    expect((describe1('Bash', { command }).rawInput as { command: string }).command).toBe(command)
  })

  it('say so when the call has none', () => {
    expect(describe1('Bash', {})).toMatchObject({ title: 'Run a command', kind: 'execute' })
  })
})

describe('the web', () => {
  it('is the kind that reaches out', () => {
    expect(describe1('WebFetch', { url: 'https://example.com/a?b=c', prompt: 'x' })).toMatchObject({ title: 'Fetch https://example.com/a?b=c', kind: 'fetch' })
    expect(describe1('WebSearch', { query: 'node streams' })).toMatchObject({ title: 'Search the web for node streams', kind: 'fetch' })
  })
})

describe('anything else', () => {
  it('is a kind the policy asks about and never allows by itself', () => {
    for (const name of ['Task', 'Agent', 'EnterWorktree', 'Workflow', 'mcp__something__run', 'SomethingNew']) expect(describe1(name, {}).kind).toBe('other')
  })

  it('has a title that cannot carry line breaks or a long name', () => {
    const title = describe1('Bad\nName', {}).title
    expect(title).toBe('Use Bad Name')
    expect(describe1('x'.repeat(200), {}).title.length).toBeLessThanOrEqual(70)
    expect(describe1('', {}).title).toBe('Use a tool')
  })

  it('is a change of mode when it asks to enter or leave plan mode, which a task is never allowed', () => {
    expect(describe1('ExitPlanMode', { plan: 'x' })).toMatchObject({ title: 'Change the mode', kind: 'switch_mode' })
    expect(describe1('EnterPlanMode', {}).kind).toBe('switch_mode')
  })

  it('treats the list of to-dos as thinking, which touches nothing', () => {
    expect(describe1('TodoWrite', { todos: [] })).toMatchObject({ title: 'Update the to-do list', kind: 'think' })
  })
})

describe('input kept for the policy', () => {
  it('cuts long texts, long lists and deep nesting', () => {
    const clipped = clipInput({ text: 'a'.repeat(10_000), list: Array.from({ length: 50 }, (_, index) => index), deep: { a: { b: { c: { d: { e: 1 } } } } }, short: 'ok', n: 3, yes: true }) as Record<string, unknown>
    expect((clipped.text as string).length).toBe(4_001)
    expect(clipped.list).toHaveLength(20)
    expect(clipped.deep).toEqual({ a: { b: {} } })
    expect(clipped).toMatchObject({ short: 'ok', n: 3, yes: true })
  })

  it('does not change what it was given', () => {
    const input = { text: 'a'.repeat(10_000) }
    clipInput(input)
    expect(input.text).toHaveLength(10_000)
  })
})

describe('one line', () => {
  it('drops control characters and collapses space', () => {
    expect(oneLine('  a \n\t b\u0000c  ')).toBe('a b c')
  })

  it('cuts with an ellipsis', () => {
    expect(oneLine('abcdefghij', 5)).toBe('abcd…')
    expect(oneLine('abc', 5)).toBe('abc')
  })
})

describe('the text of a result', () => {
  it('is a string, or the text blocks of a list, cut to the limit', () => {
    expect(resultText('plain')).toBe('plain')
    expect(resultText([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }])).toBe('one\ntwo')
    expect(resultText('x'.repeat(5_000))).toHaveLength(2_000)
    expect(resultText(42)).toBe('')
    expect(resultText(null)).toBe('')
  })
})

describe('what a file holds now', () => {
  let root: string
  let outside: string

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-claude-read-')))
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-claude-read-outside-')))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'inside\n')
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(300 * 1024))
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    try { symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt')) } catch { /* no permission to make links here: that case is skipped */ }
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('is read for a file in the project', () => {
    expect(readCurrentFile(join(root, 'src', 'a.ts'), root)).toBe('inside\n')
  })

  it('is nothing for a file that is not there, one that is too big, a folder, or a file outside the project', () => {
    expect(readCurrentFile(join(root, 'nope.txt'), root)).toBeUndefined()
    expect(readCurrentFile(join(root, 'big.txt'), root)).toBeUndefined()
    expect(readCurrentFile(join(root, 'src'), root)).toBeUndefined()
    expect(readCurrentFile(join(outside, 'secret.txt'), root)).toBeUndefined()
  })

  it('is nothing for a link that leads out of the project, so a question never shows what is outside', () => {
    expect(readCurrentFile(join(root, 'link.txt'), root)).toBeUndefined()
  })

  it('is what a diff of a real file shows as the text it replaces', () => {
    const info = describeTool('Write', { file_path: join(root, 'src', 'a.ts'), content: 'changed\n' }, { cwd: root })
    expect(info.content?.[0]).toMatchObject({ oldText: 'inside\n', newText: 'changed\n' })
    expect(isAbsolute(info.content?.[0]?.path ?? '')).toBe(true)
  })
})
