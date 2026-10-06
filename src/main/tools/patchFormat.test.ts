import { describe, expect, it } from 'vitest'
import { parsePatch, patchTargetPaths, type PatchOperation } from './patchFormat'

const parse = (text: string): PatchOperation[] => {
  const result = parsePatch(text)
  if (!result.ok) throw new Error(result.error)
  return result.operations
}
const failure = (text: string): string => {
  const result = parsePatch(text)
  if (result.ok) throw new Error('expected the patch to be rejected')
  return result.error
}
const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

describe('parsePatch', () => {
  it('parses add, update (with move, anchors and end-of-file) and delete hunks', () => {
    const operations = parse(patch(
      '*** Add File: src/new.ts',
      '+export const a = 1',
      '+',
      '+export const b = 2',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '@@ function main() {',
      ' keep',
      '-drop',
      '+add',
      '@@',
      ' tail',
      '+more',
      '*** End of File',
      '*** Delete File: gone.txt'
    ))
    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatchObject({ kind: 'add', path: 'src/new.ts', lines: ['export const a = 1', '', 'export const b = 2'] })
    expect(operations[1]).toMatchObject({ kind: 'update', path: 'src/old.ts', moveTo: 'src/renamed.ts' })
    const update = operations[1] as Extract<PatchOperation, { kind: 'update' }>
    expect(update.chunks).toHaveLength(2)
    expect(update.chunks[0]).toMatchObject({
      anchors: ['function main() {'],
      endOfFile: false,
      lines: [{ kind: 'context', text: 'keep' }, { kind: 'remove', text: 'drop' }, { kind: 'add', text: 'add' }]
    })
    expect(update.chunks[1]).toMatchObject({ anchors: [], endOfFile: true, lines: [{ kind: 'context', text: 'tail' }, { kind: 'add', text: 'more' }] })
    expect(operations[2]).toEqual({ kind: 'delete', path: 'gone.txt', line: expect.any(Number) })
  })

  it('accepts a first hunk without an @@ line and accumulates consecutive anchors', () => {
    const [update] = parse(patch(
      '*** Update File: a.py',
      ' x',
      '-y',
      '+z',
      '@@ class Foo:',
      '@@     def bar(self):',
      '-old',
      '+new'
    )) as Array<Extract<PatchOperation, { kind: 'update' }>>
    expect(update!.chunks).toHaveLength(2)
    expect(update!.chunks[0]!.anchors).toEqual([])
    expect(update!.chunks[1]!.anchors).toEqual(['class Foo:', 'def bar(self):'])
  })

  it('ignores unified-diff ranges but keeps a trailing function name as the anchor', () => {
    const [update] = parse(patch('*** Update File: a.ts', '@@ -10,3 +10,4 @@', '-a', '+b', '@@ -40,2 +41,2 @@ function tail() {', '-c', '+d')) as Array<Extract<PatchOperation, { kind: 'update' }>>
    expect(update!.chunks.map((chunk) => chunk.anchors)).toEqual([[], ['function tail() {']])
  })

  it('treats a completely empty line inside a hunk as an empty context line', () => {
    const [update] = parse(patch('*** Update File: a.txt', ' one', '', ' two', '-three', '+3')) as Array<Extract<PatchOperation, { kind: 'update' }>>
    expect(update!.chunks[0]!.lines.map((line) => line.text)).toEqual(['one', '', 'two', 'three', '3'])
    expect(update!.chunks[0]!.lines[1]).toEqual({ kind: 'context', text: '' })
  })

  it('tolerates a code fence, a heredoc wrapper, blank lines and CRLF around the envelope', () => {
    const body = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '*** End Patch']
    for (const wrapped of [
      ['```', ...body, '```'],
      ["apply_patch <<'EOF'", ...body, 'EOF'],
      ['', '', ...body, '', ''],
      ['```diff', ...body, '```', '']
    ]) {
      expect(parse(wrapped.join('\n'))).toHaveLength(1)
    }
    expect(parse(body.join('\r\n'))).toHaveLength(1)
    expect((parse(body.join('\r\n'))[0] as Extract<PatchOperation, { kind: 'add' }>).lines).toEqual(['hi'])
  })

  it('ignores blank separator lines between hunks and after an added file', () => {
    const operations = parse(patch('*** Add File: a.txt', '+one', '', '*** Delete File: b.txt', '', '*** Add File: c.txt', '+two'))
    expect(operations.map((operation) => operation.kind)).toEqual(['add', 'delete', 'add'])
    expect((operations[0] as Extract<PatchOperation, { kind: 'add' }>).lines).toEqual(['one'])
  })

  it('allows a pure move and an empty added file', () => {
    const operations = parse(patch('*** Update File: a.txt', '*** Move to: b.txt', '*** Add File: empty.txt'))
    expect(operations[0]).toMatchObject({ kind: 'update', moveTo: 'b.txt', chunks: [] })
    expect(operations[1]).toMatchObject({ kind: 'add', lines: [] })
  })

  it('strips surrounding quotes and whitespace from paths', () => {
    expect(parse(patch('*** Delete File:   "my file.txt"  '))[0]).toMatchObject({ path: 'my file.txt' })
  })

  it('rejects a missing begin or end marker and says a cut-off patch was not applied', () => {
    expect(failure('*** Add File: a.txt\n+x\n*** End Patch')).toMatch(/Begin Patch/)
    expect(failure('*** Begin Patch\n*** Add File: a.txt\n+x')).toMatch(/End Patch.*nothing was applied/is)
    expect(failure('')).toMatch(/Begin Patch/)
    expect(failure('*** Begin Patch\n*** End Patch')).toMatch(/no changes|empty/i)
  })

  it('rejects unknown lines with their patch line number', () => {
    expect(failure(patch('*** Update File: a.txt', '@@', '-a', 'oops', '+b'))).toMatch(/line 5/)
    expect(failure(patch('*** Frobnicate File: a.txt'))).toMatch(/line 2/)
    expect(failure(patch('*** Add File: a.txt', 'no plus sign'))).toMatch(/line 3.*"\+"/)
  })

  it('rejects a hunk with no lines, an update with no changes, an empty path and a stray end-of-file marker', () => {
    expect(failure(patch('*** Update File: a.txt', '@@ anchor'))).toMatch(/no lines|no changes/i)
    expect(failure(patch('*** Update File: a.txt'))).toMatch(/no changes/i)
    expect(failure(patch('*** Delete File:   '))).toMatch(/path/i)
    expect(failure(patch('*** Update File: a.txt', '*** End of File'))).toMatch(/End of File/)
    expect(failure(patch('*** Delete File: a.txt', '-surprise'))).toMatch(/line 3/)
    expect(failure(patch('*** Update File: a.txt', '*** Move to: ', '-x'))).toMatch(/path/i)
  })
})

describe('patchTargetPaths', () => {
  it('lists every path a patch would touch, including move targets', () => {
    expect(patchTargetPaths(patch('*** Add File: a.txt', '+x', '*** Update File: b.txt', '*** Move to: .git/hooks/pre-commit', '@@', '-a', '+b', '*** Delete File: c.txt')))
      .toEqual(['a.txt', 'b.txt', '.git/hooks/pre-commit', 'c.txt'])
  })

  it('still finds paths in a malformed or cut-off patch and never throws', () => {
    expect(patchTargetPaths('*** Begin Patch\n*** Update File: .git/config\n@@ nonsense')).toEqual(['.git/config'])
    expect(patchTargetPaths('garbage')).toEqual([])
    expect(patchTargetPaths(undefined as unknown as string)).toEqual([])
    expect(patchTargetPaths('*** Delete File: "a b.txt"')).toEqual(['a b.txt'])
  })
})
