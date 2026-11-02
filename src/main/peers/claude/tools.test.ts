import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clipInput, describeTool, readCurrentFile } from './tools'

const cwd = resolve(tmpdir(), 'cubex-claude-tools-project')
const inside = (...parts: string[]): string => join(cwd, ...parts)
const describe1 = (name: string, input: Record<string, unknown>, readCurrent?: (path: string) => string | undefined) => describeTool(name, input, { cwd, ...(readCurrent ? { readCurrent } : {}) })

describe('reading', () => {
  it('names the file, relative to the project, and says where', () => {
    const info = describe1('Read', { file_path: inside('src', 'a.ts') })
    expect(info).toMatchObject({ title: 'Read src/a.ts', kind: 'read', locations: [{ path: inside('src', 'a.ts') }] })
  })

  it('shows the whole path of a file outside the project, so the person sees where it is', () => {
    const elsewhere = resolve(tmpdir(), 'cubex-claude-elsewhere', 'notes.txt')
    expect(describe1('Read', { file_path: elsewhere }).title).toBe(`Read ${elsewhere.replace(/\\/g, '/')}`)
  })

  it('refuses a path with a null character as a place', () => {
    expect(describe1('Read', { file_path: 'a\u0000b' }).locations).toBeUndefined()
  })
})

describe('changing files', () => {
  it('shows a new file as all new text', () => {
    const info = describe1('Write', { file_path: 'notes.txt', content: 'hello\n' }, () => undefined)
    expect(info).toMatchObject({ title: 'Write notes.txt', kind: 'edit', locations: [{ path: inside('notes.txt') }] })
    expect(info.content).toEqual([{ type: 'diff', path: inside('notes.txt'), oldText: null, newText: 'hello\n' }])
  })

  it('shows an edit as the text it takes out and the text it puts in', () => {
    const info = describe1('Edit', { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' })
    expect(info).toMatchObject({ title: 'Edit src/a.ts', kind: 'edit' })
    expect(info.content).toEqual([{ type: 'diff', path: inside('src', 'a.ts'), oldText: 'one', newText: 'two' }])
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

  it('hand the policy the command whole, not cut to the title', () => {
    const command = `echo ${'y'.repeat(2_000)}`
    expect((describe1('Bash', { command }).rawInput as { command: string }).command).toBe(command)
  })
})

describe('anything else', () => {
  it('is a kind the policy asks about and never allows by itself', () => {
    for (const name of ['Task', 'Agent', 'EnterWorktree', 'Workflow', 'mcp__something__run', 'SomethingNew']) expect(describe1(name, {}).kind).toBe('other')
  })

  it('is a change of mode when it asks to enter or leave plan mode, which a task is never allowed', () => {
    expect(describe1('ExitPlanMode', { plan: 'x' })).toMatchObject({ title: 'Change the mode', kind: 'switch_mode' })
    expect(describe1('EnterPlanMode', {}).kind).toBe('switch_mode')
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

  it('is nothing for a link that leads out of the project, so a question never shows what is outside', () => {
    expect(readCurrentFile(join(root, 'link.txt'), root)).toBeUndefined()
  })
})
