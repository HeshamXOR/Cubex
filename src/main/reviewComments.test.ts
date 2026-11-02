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
})
