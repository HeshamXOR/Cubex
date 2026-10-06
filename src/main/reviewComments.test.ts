import { describe, expect, it } from 'vitest'
import type { ReviewComment, ReviewHunk } from '@shared/ipc'
import { changedRange } from '@shared/hunkLines'
import { buildReviewFile } from './reviewModel'
import { formatReviewComments } from '@shared/reviewComments'

const lines = (count: number, edit: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => edit[i] ?? `line ${i + 1}`).join('\n') + '\n'

/** The hunks of a real diff, so the numbers in these tests are the ones the review model produces. */
const hunksOf = (before: string, after: string, path = 'a.ts'): ReviewHunk[] => buildReviewFile(path, before, after).hunks

const comment = (extra: Partial<ReviewComment> & Pick<ReviewComment, 'path'>): ReviewComment => ({
  id: 'c1', startLine: 1, endLine: 1, side: 'new', text: 'Check this.', ...extra
})

describe('formatReviewComments', () => {
  const [hunk] = hunksOf(lines(12), lines(12, { 5: 'line 6 changed', 6: 'extra' }), 'src/app.ts')

  it('writes a whole-hunk comment as one readable block with the hunk quoted, context included', () => {
    const range = changedRange(hunk!)
    const text = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: range.start, endLine: range.end, hunkId: hunk!.id, text: 'Why change this?' }), hunk: hunk! }])
    expect(text).toBe([
      'Review comments on your changes: 1 comment in 1 file.',
      '',
      'Address each comment in the file it names. Line numbers are those of the files as they are now. When you are done, say what you changed for each one.',
      '',
      'src/app.ts',
      '',
      '1. Lines 6 to 7',
      '```diff',
      ' line 3',
      ' line 4',
      ' line 5',
      '-line 6',
      '-line 7',
      '+line 6 changed',
      '+extra',
      ' line 8',
      ' line 9',
      ' line 10',
      '```',
      'Why change this?'
    ].join('\n'))
  })

  it('quotes only the commented lines of a narrower range, with the other side between them', () => {
    const text = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: 7, endLine: 7, hunkId: hunk!.id }), hunk: hunk! }])
    expect(text).toContain('1. Line 7\n```diff\n+extra\n```\nCheck this.')
    const both = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: 5, endLine: 6, hunkId: hunk!.id }), hunk: hunk! }])
    expect(both).toContain('1. Lines 5 to 6\n```diff\n line 5\n-line 6\n-line 7\n+line 6 changed\n```')
  })

  it('numbers removed lines on the old side and says so', () => {
    const text = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: 6, endLine: 7, side: 'old', hunkId: hunk!.id, text: 'Keep these.' }), hunk: hunk! }])
    // Both removed lines are covered, so the hunk is quoted whole, with what replaced them.
    expect(text).toContain('1. Removed lines 6 to 7\n```diff\n line 3\n line 4\n line 5\n-line 6\n-line 7\n+line 6 changed\n+extra\n line 8\n line 9\n line 10\n```\nKeep these.')
    const one = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: 6, endLine: 6, side: 'old', hunkId: hunk!.id }), hunk: hunk! }])
    expect(one).toContain('1. Removed line 6\n```diff\n-line 6\n```\n')
  })

  it('quotes the whole hunk when a comment on the old side covers every removed line, as for a hunk that only removes', () => {
    const [removal] = hunksOf(lines(12), lines(12).replace('line 6\nline 7\n', ''))
    const text = formatReviewComments([{ comment: comment({ path: 'a.ts', startLine: 6, endLine: 7, side: 'old', hunkId: removal!.id }), hunk: removal! }])
    expect(text).toContain('1. Removed lines 6 to 7\n```diff\n line 3\n line 4\n line 5\n-line 6\n-line 7\n line 8\n line 9\n line 10\n```')
  })

  it('says so, and quotes nothing, when the hunk is no longer in the diff', () => {
    const text = formatReviewComments([{ comment: comment({ path: 'src/app.ts', startLine: 9, endLine: 12, text: 'Rename it.' }) }])
    expect(text).toContain('1. Lines 9 to 12\nThat part of the diff has changed since the comment was written, so no code is quoted.\nRename it.')
    expect(text).not.toContain('```')
  })

  it('groups by file in the order the files were first commented on, then by line, numbering straight through', () => {
    const text = formatReviewComments([
      { comment: comment({ id: 'a', path: 'b.ts', startLine: 30, endLine: 30, text: 'B late' }) },
      { comment: comment({ id: 'b', path: 'a.ts', startLine: 4, endLine: 4, text: 'A only' }) },
      { comment: comment({ id: 'c', path: 'b.ts', startLine: 2, endLine: 2, text: 'B early' }) }
    ])
    expect(text).toContain('3 comments in 2 files.')
    expect(text.indexOf('\nb.ts\n')).toBeLessThan(text.indexOf('\na.ts\n'))
    expect(text.indexOf('B early')).toBeLessThan(text.indexOf('B late'))
    expect(text.indexOf('B late')).toBeLessThan(text.indexOf('A only'))
    expect(text.match(/^\d+\. /gm)).toEqual(['1. ', '2. ', '3. '])
    expect(text.indexOf('1. Line 2')).toBeLessThan(text.indexOf('2. Line 30'))
  })

  it('uses a longer fence when the quoted code holds backticks', () => {
    const [tick] = hunksOf('const a = 1\n', 'const a = `x ${1}` + "```"\n')
    const text = formatReviewComments([{ comment: comment({ path: 'a.ts', startLine: 1, endLine: 1, hunkId: tick!.id }), hunk: tick! }])
    expect(text).toContain('\n````diff\n')
    expect(text).toContain('\n````\nCheck this.')
  })

  it('cuts a long quote and a long line, and says how much was left out', () => {
    const before = lines(60, { 10: `long ${'x'.repeat(300)}` })
    const after = lines(60, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 10, `changed ${i}`])))
    const [big] = hunksOf(before, after)
    const range = changedRange(big!)
    const text = formatReviewComments([{ comment: comment({ path: 'a.ts', startLine: range.start, endLine: range.end, hunkId: big!.id }), hunk: big! }])
    const block = text.split('\n')
    const start = block.indexOf('```diff')
    const end = block.indexOf('```', start + 1)
    expect(end - start - 1).toBe(25)
    expect(block[end - 1]).toMatch(/^@@ \d+ more lines @@$/)
    const clipped = block.find((line) => line.startsWith('-long')) ?? ''
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped.length).toBeLessThan(210)
  })

  it('keeps the comment text as written, trimmed', () => {
    const text = formatReviewComments([{ comment: comment({ path: 'a.ts', text: '  First line\n\nSecond paragraph.  \n' }) }])
    expect(text.endsWith('First line\n\nSecond paragraph.')).toBe(true)
  })
})
