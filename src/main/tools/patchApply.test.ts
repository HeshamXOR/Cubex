import { describe, expect, it } from 'vitest'
import { applyChunks } from './patchApply'
import { parsePatch, type PatchChunk, type PatchOperation } from './patchFormat'

const BOM = String.fromCharCode(0xfeff)

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

  it('removes lines, leaving an empty file when everything goes', () => {
    expect(apply('only\n', '-only')).toBe('')
  })

  it('reports the matched text and the result for the read ledger and the diff', () => {
    const result = applyChunks('a\nb\nc\n', chunks(' a', '-b', '+B'))
    expect(result).toMatchObject({ ok: true, before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
    if (result.ok) expect(result.chunks).toEqual([{ oldText: 'a\nb', newText: 'a\nB', anchored: false }])
  })

  it('refuses hunks that change nothing', () => {
    const result = applyChunks('a\nb\n', chunks(' a', ' b'))
    expect(result.ok).toBe(false)
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

  it('keeps the original ending of context lines even when only their whitespace matched', () => {
    // CRLF dominates, but the matched context line is LF: it must stay LF while the new line follows the majority.
    expect(apply('x\r\n  a\nb\r\n', ' a', '-b', '+B')).toBe('x\r\n  a\nB\r\n')
  })

  it('preserves a BOM', () => {
    expect(apply(`${BOM}title\nbody\n`, '-title', '+Title', ' body')).toBe(`${BOM}Title\nbody\n`)
  })

  it('preserves a missing final newline, including when lines are appended', () => {
    expect(apply('a\nb', ' a', '-b', '+B')).toBe('a\nB')
    expect(apply('a\nb', ' b', '+c')).toBe('a\nb\nc')
    expect(apply('a\r\nb', ' b', '+c')).toBe('a\r\nb\r\nc')
  })

  it('preserves a present final newline when the last line changes', () => {
    expect(apply('a\nb\n', '-b', '+B')).toBe('a\nB\n')
    expect(apply('a\nb\n', ' a', '-b')).toBe('a\n')
  })

  it('does not leave a trailing newline behind when the last line of an unterminated file is removed', () => {
    expect(apply('a\nb', ' a', '-b')).toBe('a')
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

  it('accepts an anchor that is only the start of the real line', () => {
    expect(apply('def compute(a, b):\n  return a\n', '@@ def compute', '-  return a', '+  return b')).toBe('def compute(a, b):\n  return b\n')
  })

  it('inserts a pure addition after its anchor, or at the end of the file without one', () => {
    expect(apply('a\nb\nc\n', '@@ b', '+inserted')).toBe('a\nb\ninserted\nc\n')
    expect(apply('a\nb\n', '@@', '+tail')).toBe('a\nb\ntail\n')
  })

  it('pins an end-of-file hunk to the last lines even if the same text appears earlier', () => {
    expect(apply('x\nend\nmiddle\nx\nend\n', ' x', '-end', '+END', '*** End of File')).toBe('x\nend\nmiddle\nx\nEND\n')
  })

  it('rejects hunks that are out of file order and says so', () => {
    const message = rejection('1\n2\n3\n4\n', '@@', '-4', '+four', '@@', '-1', '+one')
    expect(message).toMatch(/hunk 2/)
    expect(message).toMatch(/order/i)
  })
})

describe('applyChunks whitespace tolerance', () => {
  it('matches despite different indentation and keeps the file whitespace on context lines', () => {
    expect(apply('\tif (a) {\n\t\treturn 1\n\t}\n', ' if (a) {', '-  return 1', '+  return 2', ' }')).toBe('\tif (a) {\n  return 2\n\t}\n')
  })

  it('matches despite trailing whitespace and collapses runs of spaces', () => {
    expect(apply('a  \nb   c\n', ' a', '-b c', '+B')).toBe('a  \nB\n')
  })

  it('prefers an exact match over an earlier whitespace-only match', () => {
    expect(apply('  x\nmid\nx\n', '-x', '+X')).toBe('  x\nmid\nX\n')
  })

  it('treats typographic quotes and dashes as their ASCII forms', () => {
    const smart = `say \u201Chello\u201D \u2013 now\n`
    expect(apply(smart, '-say "hello" - now', '+say "bye" - now')).toBe('say "bye" - now\n')
  })

  it('retries without leading or trailing blank context lines the file does not have', () => {
    // The parser trims blank edges itself, so build the hunk by hand to exercise the matcher's own retry.
    const hunk = (...lines: Array<['context' | 'remove' | 'add', string]>): PatchChunk[] =>
      [{ anchors: [], endOfFile: false, line: 1, lines: lines.map(([kind, text]) => ({ kind, text })) }]
    const trailing = applyChunks('a\nb\n', hunk(['context', 'a'], ['remove', 'b'], ['add', 'B'], ['context', '']))
    expect(trailing).toMatchObject({ ok: true, text: 'a\nB\n' })
    const leading = applyChunks('a\nb\n', hunk(['context', ''], ['context', 'a'], ['remove', 'b'], ['add', 'B']))
    expect(leading).toMatchObject({ ok: true, text: 'a\nB\n' })
    // A blank line that really is there still matches normally.
    expect(applyChunks('a\n\nb\n', hunk(['context', 'a'], ['context', ''], ['remove', 'b'], ['add', 'B']))).toMatchObject({ ok: true, text: 'a\n\nB\n' })
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

  it('reports an anchor that is not in the file', () => {
    const message = rejection('a\nb\n', '@@ no such line', '-a', '+A')
    expect(message).toMatch(/no such line/)
    expect(message).toMatch(/hunk 1/)
  })

  it('says when nothing in the file resembles the hunk', () => {
    expect(rejection('alpha\nbeta\n', '-totally different words', '+x')).toMatch(/no similar/i)
  })
})
