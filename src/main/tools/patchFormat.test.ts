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

  it('rejects a missing begin or end marker and says a cut-off patch was not applied', () => {
    expect(failure('*** Add File: a.txt\n+x\n*** End Patch')).toMatch(/Begin Patch/)
    expect(failure('*** Begin Patch\n*** Add File: a.txt\n+x')).toMatch(/End Patch.*nothing was applied/is)
    expect(failure('')).toMatch(/Begin Patch/)
    expect(failure('*** Begin Patch\n*** End Patch')).toMatch(/no changes|empty/i)
  })
})

describe('patchTargetPaths', () => {
  it('lists every path a patch would touch, including move targets', () => {
    expect(patchTargetPaths(patch('*** Add File: a.txt', '+x', '*** Update File: b.txt', '*** Move to: .git/hooks/pre-commit', '@@', '-a', '+b', '*** Delete File: c.txt')))
      .toEqual(['a.txt', 'b.txt', '.git/hooks/pre-commit', 'c.txt'])
  })
})
