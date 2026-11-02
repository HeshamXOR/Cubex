import { describe, expect, it } from 'vitest'
import { applyChunks } from './patchApply'
import { parsePatch, type PatchChunk, type PatchOperation } from './patchFormat'


/** Chunks of a single "Update File" hunk written as the body lines of a patch. */
function chunks(...lines: string[]): PatchChunk[] {
  const parsed = parsePatch(['*** Begin Patch', '*** Update File: f.txt', ...lines, '*** End Patch'].join('\n'))
  if (!parsed.ok) throw new Error(parsed.error)
  return (parsed.operations[0] as Extract<PatchOperation, { kind: 'update' }>).chunks
}

function apply(text: string, ...lines: string[]): string {
  const result = applyChunks(text, chunks(...lines))
  if (!result.ok) throw new Error(result.error)
  return result.text
}
const rejection = (text: string, ...lines: string[]): string => {
  const result = applyChunks(text, chunks(...lines))
  if (result.ok) throw new Error('expected the hunk to be rejected')
  return result.error
}

describe('applyChunks basics', () => {
  it('replaces matched lines using context to locate the change', () => {
    expect(apply('a\nb\nc\nd\n', ' b', '-c', '+C', ' d')).toBe('a\nb\nC\nd\n')
  })

  it('applies several hunks in file order', () => {
    expect(apply('1\n2\n3\n4\n5\n6\n', '@@', '-2', '+two', '@@', '-5', '+five')).toBe('1\ntwo\n3\n4\nfive\n6\n')
  })
})

describe('applyChunks line endings, BOM and trailing newline', () => {
  it('keeps CRLF for untouched and new lines', () => {
    expect(apply('a\r\nb\r\nc\r\n', ' a', '-b', '+B1', '+B2', ' c')).toBe('a\r\nB1\r\nB2\r\nc\r\n')
  })

  it('never converts untouched lines of a mixed-ending file, and gives new lines the dominant ending', () => {
    // Three CRLF lines against one LF line: CRLF dominates.
    expect(apply('a\r\nb\nc\r\nd\r\n', ' a', ' b', '-c', '+C', '+C2')).toBe('a\r\nb\nC\r\nC2\r\nd\r\n')
  })

  it('preserves a missing final newline, including when lines are appended', () => {
    expect(apply('a\nb', ' a', '-b', '+B')).toBe('a\nB')
    expect(apply('a\nb', ' b', '+c')).toBe('a\nb\nc')
    expect(apply('a\r\nb', ' b', '+c')).toBe('a\r\nb\r\nc')
  })
})

describe('applyChunks placement', () => {
  it('uses @@ anchors to pick the right repeat of identical lines', () => {
    const text = 'function a() {\n  return 1\n}\nfunction b() {\n  return 1\n}\n'
    expect(apply(text, '@@ function b() {', '-  return 1', '+  return 2')).toBe('function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n')
  })

  it('stacks anchors to reach a nested block', () => {
    const text = 'class A:\n  def run(self):\n    pass\nclass B:\n  def run(self):\n    pass\n'
    expect(apply(text, '@@ class B:', '@@   def run(self):', '-    pass', '+    return 1'))
      .toBe('class A:\n  def run(self):\n    pass\nclass B:\n  def run(self):\n    return 1\n')
  })

  it('inserts a pure addition after its anchor, or at the end of the file without one', () => {
    expect(apply('a\nb\nc\n', '@@ b', '+inserted')).toBe('a\nb\ninserted\nc\n')
    expect(apply('a\nb\n', '@@', '+tail')).toBe('a\nb\ntail\n')
  })
})

describe('applyChunks whitespace tolerance', () => {
  it('matches despite different indentation and keeps the file whitespace on context lines', () => {
    expect(apply('\tif (a) {\n\t\treturn 1\n\t}\n', ' if (a) {', '-  return 1', '+  return 2', ' }')).toBe('\tif (a) {\n  return 2\n\t}\n')
  })
})

describe('applyChunks errors', () => {
  it('shows the closest region when a hunk does not match', () => {
    const text = 'function alpha() {\n  return 1\n}\n\nfunction beta() {\n  const value = compute(2)\n  return value\n}\n'
    const message = rejection(text, ' function beta() {', '-  const value = compute(3)', '+  const value = compute(4)', '   return value')
    expect(message).toMatch(/hunk 1/)
    expect(message).toMatch(/lines 5-7/)
    expect(message).toContain('const value = compute(2)')
  })
})
