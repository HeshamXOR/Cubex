import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, parseDiffMarker } from './fileTools'
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

  it('points at a single-line near miss and says which line differs', async () => {
    writeFileSync(join(root, 'diag-line.ts'), 'const a = 1\nconst title = "Hello"\nconst c = 3\n')
    const tools = await session('diag-line.ts')
    const result = await edit(tools, { path: 'diag-line.ts', old_string: 'const title = "Helo"', new_string: 'const title = "Hi"' })
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toMatch(/line 2/)
    expect(text).toContain('const title = "Hello"')
  })

  it('does not invent a candidate when nothing in the file resembles old_string', async () => {
    writeFileSync(join(root, 'diag-none.ts'), 'alpha\nbeta\ngamma\n')
    const tools = await session('diag-none.ts')
    const result = await edit(tools, { path: 'diag-none.ts', old_string: 'completely unrelated words here', new_string: 'x' })
    expect(result.isError).toBe(true)
    const text = String(result.content)
    expect(text).toContain('old_string not found')
    expect(text).toMatch(/no similar/i)
    expect(text).toMatch(/read_file/)
  })

  it('keeps the diagnostic bounded for a large old_string against a large file', async () => {
    const big = Array.from({ length: 5_000 }, (_, index) => `line ${index} of the big file`).join('\n')
    writeFileSync(join(root, 'diag-big.txt'), big)
    const tools = await session('diag-big.txt')
    const wrong = Array.from({ length: 300 }, (_, index) => `line ${index + 100} of the big FILE!`).join('\n')
    const result = await edit(tools, { path: 'diag-big.txt', old_string: wrong, new_string: 'x' })
    expect(result.isError).toBe(true)
    expect(String(result.content).length).toBeLessThan(6_000)
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

  it('truncates a very long list of matching lines', async () => {
    writeFileSync(join(root, 'diag-many.txt'), Array.from({ length: 60 }, () => 'dup').join('\n'))
    const tools = await session('diag-many.txt')
    const result = await edit(tools, { path: 'diag-many.txt', old_string: 'dup', new_string: 'uniq' })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/appears 60 times/)
    expect(String(result.content)).toMatch(/more/)
    expect(String(result.content).length).toBeLessThan(1_500)
  })

  it('honors replace_all and reports how many replacements were made', async () => {
    writeFileSync(join(root, 'diag-all.ts'), 'x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n')
    const tools = await session('diag-all.ts')
    const result = await edit(tools, { path: 'diag-all.ts', old_string: 'x = 1', new_string: 'x = 9', replace_all: true })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('3 replacements')
    expect(parseDiffMarker(String(result.content))).toEqual({ added: 3, removed: 3 })
    expect(bytes('diag-all.ts').toString('utf8')).toBe('x = 9\ny = 2\nx = 9\nz = 3\nx = 9\n')
  })

  it('still fails replace_all when there is no match, with a diagnostic', async () => {
    writeFileSync(join(root, 'diag-all-none.ts'), 'one\ntwo\n')
    const tools = await session('diag-all-none.ts')
    const result = await edit(tools, { path: 'diag-all-none.ts', old_string: 'three', new_string: 'x', replace_all: true })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('old_string not found')
  })
})

describe('edit_file line endings, BOM and trailing newline', () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  // The decoded form of the BOM: a model may copy this invisible character into old_string.
  const BOM_CHAR = String.fromCharCode(0xfeff)

  it('matches an LF old_string in a CRLF file and keeps every line CRLF', async () => {
    writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n')
    const tools = await session('crlf.txt')
    const result = await edit(tools, { path: 'crlf.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE\nextra' })
    expect(result.isError).toBeFalsy()
    expect(bytes('crlf.txt').toString('utf8')).toBe('one\r\nTWO\r\nTHREE\r\nextra\r\nfour\r\n')
  })

  it('also accepts an old_string that itself uses CRLF', async () => {
    writeFileSync(join(root, 'crlf-explicit.txt'), 'one\r\ntwo\r\nthree\r\n')
    const tools = await session('crlf-explicit.txt')
    const result = await edit(tools, { path: 'crlf-explicit.txt', old_string: 'one\r\ntwo', new_string: 'ONE\r\nTWO' })
    expect(result.isError).toBeFalsy()
    expect(bytes('crlf-explicit.txt').toString('utf8')).toBe('ONE\r\nTWO\r\nthree\r\n')
  })

  it('reports line counts for a CRLF edit without counting carriage returns as changes', async () => {
    writeFileSync(join(root, 'crlf-diff.txt'), 'a\r\nb\r\nc\r\n')
    const tools = await session('crlf-diff.txt')
    const result = await edit(tools, { path: 'crlf-diff.txt', old_string: 'b', new_string: 'B' })
    expect(parseDiffMarker(String(result.content))).toEqual({ added: 1, removed: 1 })
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

  it('uses LF for new line breaks in an LF-dominant file that contains a few CRLF lines', async () => {
    writeFileSync(join(root, 'mostly-lf.txt'), 'a\nb\nc\r\nd\ne\n')
    const tools = await session('mostly-lf.txt')
    const result = await edit(tools, { path: 'mostly-lf.txt', old_string: 'd', new_string: 'D1\nD2' })
    expect(result.isError).toBeFalsy()
    expect(bytes('mostly-lf.txt').toString('utf8')).toBe('a\nb\nc\r\nD1\nD2\ne\n')
  })

  it('matches across a line that is LF in a mostly-CRLF file', async () => {
    writeFileSync(join(root, 'mixed-span.txt'), 'a\r\nb\nc\r\nd\r\n')
    const tools = await session('mixed-span.txt')
    const result = await edit(tools, { path: 'mixed-span.txt', old_string: 'a\nb\nc', new_string: 'A\nB\nC' })
    expect(result.isError).toBeFalsy()
    expect(bytes('mixed-span.txt').toString('utf8')).toBe('A\r\nB\r\nC\r\nd\r\n')
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

  it('does not double a BOM when old_string and new_string carry one', async () => {
    writeFileSync(join(root, 'bom-explicit.txt'), Buffer.concat([BOM, Buffer.from('title\nbody\n', 'utf8')]))
    const tools = await session('bom-explicit.txt')
    const result = await edit(tools, { path: 'bom-explicit.txt', old_string: `${BOM_CHAR}title`, new_string: `${BOM_CHAR}Heading` })
    expect(result.isError).toBeFalsy()
    const out = bytes('bom-explicit.txt')
    expect(out.subarray(0, 3).equals(BOM)).toBe(true)
    expect(out.subarray(3).toString('utf8')).toBe('Heading\nbody\n')
  })

  it('does not add a BOM to a file that has none', async () => {
    writeFileSync(join(root, 'no-bom.txt'), 'title\nbody\n')
    const tools = await session('no-bom.txt')
    await edit(tools, { path: 'no-bom.txt', old_string: 'title', new_string: 'Heading' })
    expect(bytes('no-bom.txt').subarray(0, 3).equals(BOM)).toBe(false)
    expect(bytes('no-bom.txt').toString('utf8')).toBe('Heading\nbody\n')
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

  it('applies replace_all to a CRLF file with multi-line matches', async () => {
    writeFileSync(join(root, 'crlf-all.txt'), 'if (a)\r\n  go()\r\nelse\r\n  stop()\r\nif (a)\r\n  go()\r\n')
    const tools = await session('crlf-all.txt')
    const result = await edit(tools, { path: 'crlf-all.txt', old_string: 'if (a)\n  go()', new_string: 'if (b)\n  run()', replace_all: true })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('2 replacements')
    expect(bytes('crlf-all.txt').toString('utf8')).toBe('if (b)\r\n  run()\r\nelse\r\n  stop()\r\nif (b)\r\n  run()\r\n')
  })

  it('reports the closest region with line numbers for a CRLF file', async () => {
    writeFileSync(join(root, 'crlf-miss.txt'), 'a\r\nconst x = 1\r\nc\r\n')
    const tools = await session('crlf-miss.txt')
    const result = await edit(tools, { path: 'crlf-miss.txt', old_string: 'const x = 2', new_string: 'const x = 3' })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/line 2/)
    expect(String(result.content)).toContain('const x = 1')
    // Diagnostics never leak carriage returns into the model-visible text.
    expect(String(result.content)).not.toContain('\r')
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
