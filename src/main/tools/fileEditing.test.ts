import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools } from './fileTools'
import type { JSONValue, ToolExecutionContext } from '@core/types'

/**
 * edit_file reliability: match diagnostics (closest region, ambiguity listing),
 * and exact preservation of line endings, BOM and the trailing newline.
 */

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-edit-'))
  mkdirSync(join(root, 'src'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Tools = ReturnType<typeof createFileTools>
const named = (tools: Tools, name: string) => tools.find((item) => item.definition.name === name)!

/** A fresh tool set that has fully read `path`, as the model must before editing. */
async function session(path: string, onMutate?: Parameters<typeof createFileTools>[1]): Promise<Tools> {
  const tools = createFileTools(root, onMutate)
  const read = await named(tools, 'read_file').execute({ path }, ctx)
  expect(read.isError).toBeFalsy()
  return tools
}

async function edit(tools: Tools, input: JSONValue) {
  return named(tools, 'edit_file').execute(input, ctx)
}

const bytes = (path: string): Buffer => readFileSync(join(root, path))

describe('edit_file match diagnostics', () => {
  const source = [
    'function alpha() {',
    '  return 1',
    '}',
    '',
    'function beta() {',
    '  const value = compute(2)',
    '  return value',
    '}',
    ''
  ].join('\n')

  it('reports the closest region with line numbers and the exact lines when old_string drifted', async () => {
    writeFileSync(join(root, 'diag-closest.ts'), source)
    const tools = await session('diag-closest.ts')
    const result = await edit(tools, {
      path: 'diag-closest.ts',
      old_string: 'function beta() {\n    const value = compute(3)\n    return value\n}',
      new_string: 'function beta() {\n  return 0\n}'
    })
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toContain('old_string not found')
    expect(text).toMatch(/lines? 5-8/)
    // The file's real text is shown verbatim so the model can copy it.
    expect(text).toContain('const value = compute(2)')
    expect(text).toContain('function beta() {')
    expect(bytes('diag-closest.ts').toString('utf8')).toBe(source)
  })

  it('says when the only difference is whitespace and shows the exact whitespace', async () => {
    writeFileSync(join(root, 'diag-ws.ts'), 'if (ok) {\n\treturn 1\n}\n')
    const tools = await session('diag-ws.ts')
    const result = await edit(tools, {
      path: 'diag-ws.ts', old_string: 'if (ok) {\n    return 1\n}', new_string: 'if (ok) {\n    return 2\n}'
    })
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toMatch(/whitespace/i)
    expect(text).toMatch(/lines? 1-3/)
    // Tabs are made visible so the model can tell them from spaces.
    expect(text).toContain('\\treturn 1')
  })

  it('lists every matching line number when old_string is ambiguous and explains how to disambiguate', async () => {
    writeFileSync(join(root, 'diag-dup.ts'), 'x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n')
    const tools = await session('diag-dup.ts')
    const result = await edit(tools, { path: 'diag-dup.ts', old_string: 'x = 1', new_string: 'x = 9' })
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toMatch(/appears 3 times/)
    expect(text).toMatch(/lines? 1, 3, 5/)
    expect(text).toMatch(/surrounding/i)
    expect(text).toMatch(/replace_all/)
    expect(bytes('diag-dup.ts').toString('utf8')).toBe('x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n')
  })
})

describe('edit_file line endings, BOM and trailing newline', () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  // The decoded form of the BOM: a model may copy this invisible character into old_string.

  it('matches an LF old_string in a CRLF file and keeps every line CRLF', async () => {
    writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n')
    const tools = await session('crlf.txt')
    const result = await edit(tools, { path: 'crlf.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE\nextra' })
    expect(result.isError).toBeFalsy()
    expect(bytes('crlf.txt').toString('utf8')).toBe('one\r\nTWO\r\nTHREE\r\nextra\r\nfour\r\n')
  })

  it('never converts the endings of untouched lines in a mixed-ending file', async () => {
    // Dominant ending is CRLF (3 vs 2); two lines are LF and must stay LF.
    writeFileSync(join(root, 'mixed.txt'), 'a\r\nb\r\nc\nd\ne\r\n')
    const tools = await session('mixed.txt')
    const result = await edit(tools, { path: 'mixed.txt', old_string: 'b', new_string: 'B1\nB2' })
    expect(result.isError).toBeFalsy()
    // New line breaks use the file's dominant ending; nothing else changes.
    expect(bytes('mixed.txt').toString('utf8')).toBe('a\r\nB1\r\nB2\r\nc\nd\ne\r\n')
  })

  it('preserves a UTF-8 BOM when editing the first line', async () => {
    writeFileSync(join(root, 'bom.txt'), Buffer.concat([BOM, Buffer.from('title\r\nbody\r\n', 'utf8')]))
    const tools = await session('bom.txt')
    const result = await edit(tools, { path: 'bom.txt', old_string: 'title', new_string: 'Heading' })
    expect(result.isError).toBeFalsy()
    const out = bytes('bom.txt')
    expect(out.subarray(0, 3).equals(BOM)).toBe(true)
    expect(out.subarray(3).toString('utf8')).toBe('Heading\r\nbody\r\n')
  })

  it.each([
    ['LF without a final newline', 'x\ny', 'x\nY'],
    ['LF with a final newline', 'x\ny\n', 'x\nY\n'],
    ['CRLF without a final newline', 'x\r\ny', 'x\r\nY'],
    ['CRLF with a final newline', 'x\r\ny\r\n', 'x\r\nY\r\n']
  ])('keeps the trailing newline state: %s', async (_label, before, after) => {
    const path = `trailing-${Buffer.from(before).toString('hex')}.txt`
    writeFileSync(join(root, path), before)
    const tools = await session(path)
    const result = await edit(tools, { path, old_string: 'y', new_string: 'Y' })
    expect(result.isError).toBeFalsy()
    expect(bytes(path).toString('utf8')).toBe(after)
  })

  it('reports an unchanged-content edit as an error instead of rewriting the file', async () => {
    writeFileSync(join(root, 'same.txt'), 'same\n')
    const tools = await session('same.txt')
    const result = await edit(tools, { path: 'same.txt', old_string: 'same', new_string: 'same' })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/identical/)
  })

  it('checkpoints the exact before and after bytes of a CRLF + BOM edit', async () => {
    const original = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n', 'utf8')])
    writeFileSync(join(root, 'checkpoint-crlf.txt'), original)
    const seen: Array<{ before: Buffer; after?: Buffer | null }> = []
    const tools = await session('checkpoint-crlf.txt', (_abs, before, _existed, after) => seen.push({ before, ...(after !== undefined ? { after } : {}) }))
    const result = await edit(tools, { path: 'checkpoint-crlf.txt', old_string: 'b', new_string: 'B' })
    expect(result.isError).toBeFalsy()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.before.equals(original)).toBe(true)
    expect(seen[0]!.after).toEqual(Buffer.concat([BOM, Buffer.from('a\r\nB\r\n', 'utf8')]))
  })
})
