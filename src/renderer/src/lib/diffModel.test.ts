import { describe, expect, it } from 'vitest'
import { diffStats, parseDiff, toSplit, wordMarks, type DiffRow } from './diffModel'

const SAMPLE = [
  ' import { fetchWithAuth } from \'./auth\'',
  '+import { withBackoff } from \'./backoff\'',
  ' export async function uploadChunk(chunk: Chunk) {',
  '-  const res = await put(chunk)',
  '-  if (!res.ok) throw new UploadError(res.status)',
  '+  return withBackoff(async () => {',
  '+    if (!res.ok) throw new UploadError(res.status, wait)',
  ' }',
  '@⋯ 34 unchanged lines'
].join('\n')

describe('parseDiff', () => {
  it('numbers old and new lines independently', () => {
    const rows = parseDiff(SAMPLE).filter((item): item is DiffRow => item.kind !== 'gap' && item.kind !== 'hunk')
    expect(rows[0]).toMatchObject({ kind: 'ctx', oldNo: 1, newNo: 1 })
    expect(rows[1]).toMatchObject({ kind: 'add', newNo: 2 })
    expect(rows[1]!.oldNo).toBeUndefined()
    expect(rows[2]).toMatchObject({ kind: 'ctx', oldNo: 2, newNo: 3 })
    expect(rows[3]).toMatchObject({ kind: 'del', oldNo: 3 })
    expect(rows[4]).toMatchObject({ kind: 'del', oldNo: 4 })
    expect(rows[5]).toMatchObject({ kind: 'add', newNo: 4 })
    expect(rows[7]).toMatchObject({ kind: 'ctx', oldNo: 5, newNo: 6 })
  })

  it('opens a hunk with a computed header and closes it at a gap', () => {
    const items = parseDiff(SAMPLE)
    expect(items[0]).toMatchObject({ kind: 'hunk', oldStart: 1, newStart: 1, oldLines: 5, newLines: 6, header: '@@ -1,5 +1,6 @@' })
    expect(items.at(-1)).toMatchObject({ kind: 'gap', hidden: 34, text: '34 unchanged lines' })
  })

  it('skips the numbers a leading gap hides', () => {
    const items = parseDiff(['@⋯ 10 unchanged lines', '-old', '+new'].join('\n'))
    expect(items[0]).toMatchObject({ kind: 'gap', hidden: 10 })
    expect(items[1]).toMatchObject({ kind: 'hunk', oldStart: 11, newStart: 11 })
    expect(items[2]).toMatchObject({ kind: 'del', oldNo: 11 })
    expect(items[3]).toMatchObject({ kind: 'add', newNo: 11 })
  })

  it('starts a new hunk after each gap', () => {
    const items = parseDiff([' a', '-b', '@⋯ 5 unchanged lines', '+c', ' d'].join('\n'))
    expect(items.filter((item) => item.kind === 'hunk')).toHaveLength(2)
  })

  it('shows a plain notice for a gap that is not an unchanged run', () => {
    const items = parseDiff('@500 lines replaced with 520 lines')
    expect(items[0]).toMatchObject({ kind: 'gap', hidden: 0, text: '500 lines replaced with 520 lines' })
  })

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([])
  })

  it('keeps an untagged line instead of dropping it', () => {
    const items = parseDiff('plain')
    expect(items.find((item) => item.kind === 'ctx')).toMatchObject({ text: 'plain' })
  })

  it('counts added and removed lines', () => {
    expect(diffStats(parseDiff(SAMPLE))).toEqual({ added: 3, removed: 2 })
  })
})

describe('word emphasis', () => {
  it('marks only the words that changed in a replaced line', () => {
    const marks = wordMarks('throw new UploadError(res.status)', 'throw new UploadError(res.status, wait)')
    expect(marks).toBeDefined()
    const added = marks!.new.map(([start, end]) => 'throw new UploadError(res.status, wait)'.slice(start, end))
    expect(added.join('|')).toContain('wait')
    expect(marks!.old).toEqual([])
  })

  it('joins nearby changes across a single space', () => {
    const before = 'let total = a + b'
    const after = 'let total = c + d'
    const marks = wordMarks(before, after)!
    expect(marks.old.map(([s, e]) => before.slice(s, e))).toEqual(['a', 'b'])
  })

  it('does not mark lines that share almost nothing', () => {
    expect(wordMarks('const res = await put(chunk)', 'return withBackoff(async () => {')).toBeUndefined()
  })

  it('returns nothing for identical lines', () => {
    expect(wordMarks('same', 'same')).toBeUndefined()
  })

  it('attaches marks to the lines that were paired', () => {
    const rows = parseDiff(['-  if (!res.ok) throw new UploadError(res.status)', '+  if (!res.ok) throw new UploadError(res.status, wait)'].join('\n'))
    const del = rows.find((item) => item.kind === 'del') as DiffRow
    const add = rows.find((item) => item.kind === 'add') as DiffRow
    expect(del.marks).toBeUndefined()
    expect(add.marks?.length).toBeGreaterThan(0)
  })
})

describe('toSplit', () => {
  it('shows context on both sides and pairs a removed line with its replacement', () => {
    const split = toSplit(parseDiff([' a', '-b', '-c', '+d', ' e'].join('\n')))
    const rows = split.filter((item) => item.kind === 'row')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ left: { text: 'a' }, right: { text: 'a' } })
    expect(rows[1]).toMatchObject({ left: { text: 'b' }, right: { text: 'd' } })
    expect(rows[2]).toMatchObject({ left: { text: 'c' } })
    expect((rows[2] as { right?: unknown }).right).toBeUndefined()
    expect(rows[3]).toMatchObject({ left: { text: 'e' }, right: { text: 'e' } })
  })

  it('leaves the left side empty for a pure insertion', () => {
    const split = toSplit(parseDiff('+x\n+y'))
    const rows = split.filter((item) => item.kind === 'row') as Array<{ left?: unknown; right?: DiffRow }>
    expect(rows.map((row) => row.left)).toEqual([undefined, undefined])
    expect(rows.map((row) => row.right?.text)).toEqual(['x', 'y'])
  })

  it('passes hunks and gaps through', () => {
    const kinds = toSplit(parseDiff(SAMPLE)).map((item) => item.kind)
    expect(kinds[0]).toBe('hunk')
    expect(kinds.at(-1)).toBe('gap')
  })
})
