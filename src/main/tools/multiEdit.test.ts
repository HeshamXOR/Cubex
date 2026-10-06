import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, parseDiffMarker, parseDiffBody } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-multi-'))
  mkdirSync(join(root, 'src'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Tools = ReturnType<typeof createFileTools>
const named = (tools: Tools, name: string) => tools.find((item) => item.definition.name === name)!
const multi = (tools: Tools, input: JSONValue) => named(tools, 'multi_edit').execute(input, ctx)
const text = (path: string): string => readFileSync(join(root, path), 'utf8')

async function session(path: string, onMutate?: Parameters<typeof createFileTools>[1]): Promise<Tools> {
  const tools = createFileTools(root, onMutate)
  expect((await named(tools, 'read_file').execute({ path }, ctx)).isError).toBeFalsy()
  return tools
}

describe('multi_edit definition', () => {
  it('is registered with the same permission class as edit_file and a strict schema', () => {
    const tools = createFileTools(root)
    const definition = named(tools, 'multi_edit').definition
    expect(named(tools, 'multi_edit').defaultPermission).toBe('ask')
    expect(named(tools, 'edit_file').defaultPermission).toBe('ask')
    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      required: ['path', 'edits'],
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: { type: 'object', required: ['old_string', 'new_string'], properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } }
        }
      }
    })
  })
})

describe('multi_edit', () => {
  it('applies edits in order to the evolving content', async () => {
    writeFileSync(join(root, 'order.txt'), 'alpha\nbeta\ngamma\n')
    const tools = await session('order.txt')
    const result = await multi(tools, {
      path: 'order.txt',
      edits: [
        { old_string: 'alpha', new_string: 'one' },
        // Only exists because the first edit produced it.
        { old_string: 'one\nbeta', new_string: 'one\ntwo' },
        { old_string: 'gamma', new_string: 'three' }
      ]
    })
    expect(result.isError).toBeFalsy()
    expect(text('order.txt')).toBe('one\ntwo\nthree\n')
    expect(String(result.content)).toContain('3 edits')
    expect(parseDiffMarker(String(result.content))).toEqual({ added: 3, removed: 3 })
    expect(parseDiffBody(String(result.content))).toContain('+three')
  })

  it('is all-or-nothing and names the failing edit index', async () => {
    writeFileSync(join(root, 'atomic.txt'), 'a\nb\nc\n')
    const mutations: string[] = []
    const tools = await session('atomic.txt', (_abs, _before, _existed, after) => mutations.push(String(after)))
    const result = await multi(tools, {
      path: 'atomic.txt',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'missing text', new_string: 'x' },
        { old_string: 'c', new_string: 'C' }
      ]
    })
    expect(result.isError).toBe(true)
    const message = String(result.content)
    expect(message).toMatch(/edits\[1\]/)
    expect(message).toMatch(/edit 2 of 3/)
    expect(message).toMatch(/nothing was changed/i)
    expect(message).toContain('old_string not found')
    expect(text('atomic.txt')).toBe('a\nb\nc\n')
    expect(mutations).toEqual([])
    // The ledger is untouched by the failure, so a corrected call still works without re-reading.
    const retry = await multi(tools, { path: 'atomic.txt', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] })
    expect(retry.isError).toBeFalsy()
    expect(text('atomic.txt')).toBe('A\nb\nC\n')
  })

  it('reports ambiguity for a later edit with line numbers and its index', async () => {
    writeFileSync(join(root, 'ambiguous.txt'), 'x\ny\nx\n')
    const tools = await session('ambiguous.txt')
    const result = await multi(tools, { path: 'ambiguous.txt', edits: [{ old_string: 'y', new_string: 'Y' }, { old_string: 'x', new_string: 'X' }] })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/edits\[1\]/)
    expect(String(result.content)).toMatch(/appears 2 times/)
    expect(String(result.content)).toMatch(/lines 1, 3/)
    expect(text('ambiguous.txt')).toBe('x\ny\nx\n')
  })

  it('honors replace_all per edit', async () => {
    writeFileSync(join(root, 'all.txt'), 'x x\ny\nx\n')
    const tools = await session('all.txt')
    const result = await multi(tools, { path: 'all.txt', edits: [{ old_string: 'x', new_string: 'z', replace_all: true }, { old_string: 'y', new_string: 'w' }] })
    expect(result.isError).toBeFalsy()
    expect(text('all.txt')).toBe('z z\nw\nz\n')
    expect(String(result.content)).toContain('2 edits')
    expect(String(result.content)).toContain('4 replacements')
  })

  it('preserves CRLF endings, the BOM and the final newline across every edit', async () => {
    writeFileSync(join(root, 'crlf.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\r\nd', 'utf8')]))
    const tools = await session('crlf.txt')
    const result = await multi(tools, { path: 'crlf.txt', edits: [{ old_string: 'a\nb', new_string: 'A\nB\nB2' }, { old_string: 'd', new_string: 'D' }] })
    expect(result.isError).toBeFalsy()
    const bytes = readFileSync(join(root, 'crlf.txt'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('A\r\nB\r\nB2\r\nc\r\nD')
  })

  it('records one checkpoint with the original and the final bytes', async () => {
    writeFileSync(join(root, 'checkpoint.txt'), 'one\ntwo\n')
    const calls: Array<{ before: string; existed: boolean; after?: string | null }> = []
    const tools = await session('checkpoint.txt', (_abs, before, existed, after) => calls.push({ before: before.toString('utf8'), existed, after: after === null || after === undefined ? after : after.toString('utf8') }))
    expect((await multi(tools, { path: 'checkpoint.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'two', new_string: '2' }] })).isError).toBeFalsy()
    expect(calls).toEqual([{ before: 'one\ntwo\n', existed: true, after: '1\n2\n' }])
  })

  it('keeps the read ledger valid so edit_file can follow without another read', async () => {
    writeFileSync(join(root, 'follow.txt'), 'p\nq\n')
    const tools = await session('follow.txt')
    expect((await multi(tools, { path: 'follow.txt', edits: [{ old_string: 'p', new_string: 'P' }] })).isError).toBeFalsy()
    expect((await named(tools, 'edit_file').execute({ path: 'follow.txt', old_string: 'q', new_string: 'Q' }, ctx)).isError).toBeFalsy()
    expect(text('follow.txt')).toBe('P\nQ\n')
  })

  it('requires a prior read and refuses stale files', async () => {
    writeFileSync(join(root, 'ledger.txt'), 'known')
    const unread = createFileTools(root)
    const blocked = await multi(unread, { path: 'ledger.txt', edits: [{ old_string: 'known', new_string: 'x' }] })
    expect(blocked.isError).toBe(true)
    expect(String(blocked.content)).toContain('have not read')
    const tools = await session('ledger.txt')
    writeFileSync(join(root, 'ledger.txt'), 'known plus manual change')
    const stale = await multi(tools, { path: 'ledger.txt', edits: [{ old_string: 'known', new_string: 'x' }] })
    expect(stale.isError).toBe(true)
    expect(String(stale.content)).toContain('changed since you read')
    expect(text('ledger.txt')).toBe('known plus manual change')
  })

  it('limits partial-read edits to inspected text, including text introduced by earlier edits', async () => {
    writeFileSync(join(root, 'paged.txt'), 'one\ntwo\nthree\nfour\n')
    const tools = createFileTools(root)
    await named(tools, 'read_file').execute({ path: 'paged.txt', offset: 2, limit: 2 }, ctx)
    const outside = await multi(tools, { path: 'paged.txt', edits: [{ old_string: 'two', new_string: 'TWO' }, { old_string: 'four', new_string: 'FOUR' }] })
    expect(outside.isError).toBe(true)
    expect(String(outside.content)).toMatch(/edits\[1\]/)
    expect(String(outside.content)).toContain('not included in the pages')
    expect(text('paged.txt')).toBe('one\ntwo\nthree\nfour\n')
    const chained = await multi(tools, { path: 'paged.txt', edits: [{ old_string: 'two', new_string: 'TWO\nTWO-B' }, { old_string: 'TWO-B', new_string: 'done' }] })
    expect(chained.isError).toBeFalsy()
    expect(text('paged.txt')).toBe('one\nTWO\ndone\nthree\nfour\n')
  })

  it('requires a full read when any edit uses replace_all', async () => {
    writeFileSync(join(root, 'paged-all.txt'), 'r\nr\n')
    const tools = createFileTools(root)
    await named(tools, 'read_file').execute({ path: 'paged-all.txt', limit: 1 }, ctx)
    const result = await multi(tools, { path: 'paged-all.txt', edits: [{ old_string: 'r', new_string: 's', replace_all: true }] })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('Only part')
  })

  it('validates the input shape before touching the file', async () => {
    writeFileSync(join(root, 'shape.txt'), 'content')
    const tools = await session('shape.txt')
    const bad: Array<[JSONValue, RegExp]> = [
      [{ edits: [{ old_string: 'a', new_string: 'b' }] }, /requires "path"/],
      [{ path: 'shape.txt' }, /"edits"/],
      [{ path: 'shape.txt', edits: [] }, /at least one edit/],
      [{ path: 'shape.txt', edits: 'nope' }, /"edits"/],
      [{ path: 'shape.txt', edits: [{ old_string: '', new_string: 'b' }] }, /edits\[0\].*old_string/],
      [{ path: 'shape.txt', edits: [{ old_string: 'content', new_string: 5 }] }, /edits\[0\].*new_string/],
      [{ path: 'shape.txt', edits: [{ old_string: 'content', new_string: 'x', replace_all: 'yes' }] }, /edits\[0\].*replace_all/],
      [{ path: 'shape.txt', edits: [null] }, /edits\[0\]/],
      [{ path: 'shape.txt', edits: [{ old_string: 'content', new_string: 'x' }, { old_string: 'x', new_string: 'x' }] }, /edits\[1\].*identical/]
    ]
    for (const [input, expected] of bad) {
      const result = await multi(tools, input)
      expect(result.isError, JSON.stringify(input)).toBe(true)
      expect(String(result.content), JSON.stringify(input)).toMatch(expected)
    }
    expect(text('shape.txt')).toBe('content')
  })

  it('caps the number of edits per call', async () => {
    writeFileSync(join(root, 'cap.txt'), 'x')
    const tools = await session('cap.txt')
    const edits = Array.from({ length: 101 }, (_, index) => ({ old_string: `a${index}`, new_string: `b${index}` }))
    const result = await multi(tools, { path: 'cap.txt', edits })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/at most 100/)
  })

  it('rejects missing files, binary files and escapes without writing', async () => {
    const tools = createFileTools(root)
    const missing = await multi(tools, { path: 'ghost.txt', edits: [{ old_string: 'a', new_string: 'b' }] })
    expect(String(missing.content)).toMatch(/does not exist/)
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x61]))
    const binary = await session('binary.bin')
    const refused = await multi(binary, { path: 'binary.bin', edits: [{ old_string: 'a', new_string: 'b' }] })
    expect(refused.isError).toBe(true)
    expect(String(refused.content)).toMatch(/binary or not valid UTF-8/)
    const escape = await multi(tools, { path: '../outside.txt', edits: [{ old_string: 'a', new_string: 'b' }] })
    expect(String(escape.content)).toMatch(/escapes the workspace/)
  })

  it('does not write when the turn is cancelled and surfaces a write failure without a checkpoint', async () => {
    writeFileSync(join(root, 'cancel.txt'), 'keep')
    const onMutate = vi.fn()
    const tools = await session('cancel.txt', onMutate)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await named(tools, 'multi_edit').execute({ path: 'cancel.txt', edits: [{ old_string: 'keep', new_string: 'x' }] }, { ...ctx, signal: controller.signal })
    expect(cancelled).toMatchObject({ isError: true, content: 'multi_edit cancelled.' })
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    try {
      const failed = await multi(tools, { path: 'cancel.txt', edits: [{ old_string: 'keep', new_string: 'x' }] })
      expect(failed.isError).toBe(true)
      expect(onMutate).not.toHaveBeenCalled()
      expect(text('cancel.txt')).toBe('keep')
    } finally { spy.mockRestore() }
  })
})
