import { describe, expect, it } from 'vitest'
import type { ReviewFile, ReviewHunk } from '../../../shared/ipc'
import { anchorRow, describeRange, describeRangeInline, excerptOf, hunkAnchor, hunkItems, hunkRows, noteIndex, rowRange, sameReview, splitHunkRows, staleReason, undoneText, unchangedBefore } from './hunkReview'

const hunk = (lines: string[], oldStart: number, oldLines: number, newStart: number, newLines: number, id = 'h'): ReviewHunk =>
  ({ id, header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, oldLines, newStart, newLines, lines, state: 'pending' })

/** Lines 6 and 7 replaced by two others, three lines of context each side. */
const replaced = hunk([' l3', ' l4', ' l5', '-six', '-seven', '+six changed', '+extra', ' l8', ' l9', ' l10'], 3, 8, 3, 8)
const removed = hunk([' l3', ' l4', ' l5', '-six', '-seven', ' l8', ' l9', ' l10'], 3, 8, 3, 6)
const added = hunk([' l1', ' l2', ' l3', '+new one', '+new two'], 1, 3, 1, 5)

describe('hunkRows', () => {
  it('numbers each row on both sides and tells added, removed and unchanged apart', () => {
    const rows = hunkRows(replaced)
    expect(rows.map((row) => [row.kind, row.oldNo, row.newNo, row.text])).toEqual([
      ['ctx', 3, 3, 'l3'], ['ctx', 4, 4, 'l4'], ['ctx', 5, 5, 'l5'],
      ['del', 6, undefined, 'six'], ['del', 7, undefined, 'seven'],
      ['add', undefined, 6, 'six changed'], ['add', undefined, 7, 'extra'],
      ['ctx', 8, 8, 'l8'], ['ctx', 9, 9, 'l9'], ['ctx', 10, 10, 'l10']
    ])
  })

  it('marks the words that changed between a removed line and the line that replaced it', () => {
    const rows = hunkRows(hunk(['-const a = 1', '+const a = 2'], 1, 1, 1, 1))
    expect(rows[0]!.marks).toEqual([[10, 11]])
    expect(rows[1]!.marks).toEqual([[10, 11]])
  })
})

describe('hunkAnchor', () => {
  it('covers the lines a hunk changed, on the new side', () => {
    expect(hunkAnchor(replaced)).toEqual({ startLine: 6, endLine: 7, side: 'new' })
    expect(hunkAnchor(added)).toEqual({ startLine: 4, endLine: 5, side: 'new' })
  })

  it('moves to the old side for a hunk that only removes lines', () => {
    expect(hunkAnchor(removed)).toEqual({ startLine: 6, endLine: 7, side: 'old' })
  })
})

describe('rowRange', () => {
  it('puts a removed line on the old side and every other line on the new', () => {
    const rows = hunkRows(replaced)
    expect(rowRange(rows[3]!)).toEqual({ startLine: 6, endLine: 6, side: 'old' })
    expect(rowRange(rows[5]!)).toEqual({ startLine: 6, endLine: 6, side: 'new' })
    expect(rowRange(rows[0]!)).toEqual({ startLine: 3, endLine: 3, side: 'new' })
  })
})

describe('describeRange', () => {
  it('says what the message to the model says', () => {
    expect(describeRange({ startLine: 14, endLine: 14, side: 'new' })).toBe('Line 14')
    expect(describeRange({ startLine: 12, endLine: 18, side: 'new' })).toBe('Lines 12 to 18')
    expect(describeRange({ startLine: 5, endLine: 5, side: 'old' })).toBe('Removed line 5')
    expect(describeRange({ startLine: 5, endLine: 7, side: 'old' })).toBe('Removed lines 5 to 7')
  })

  it('reads the same in the middle of a sentence', () => {
    expect(describeRangeInline({ startLine: 12, endLine: 18, side: 'new' })).toBe('lines 12 to 18')
    expect(describeRangeInline({ startLine: 5, endLine: 5, side: 'old' })).toBe('removed line 5')
  })
})

describe('unchangedBefore', () => {
  it('counts the lines above the first hunk and between hunks', () => {
    expect(unchangedBefore(undefined, replaced)).toBe(2)
    expect(unchangedBefore(undefined, added)).toBe(0)
    const later = hunk([' a', '-b', ' c'], 20, 3, 22, 2)
    expect(unchangedBefore(replaced, later)).toBe(20 - 10 - 1)
  })

  it('reads a start with no lines as the line before the gap', () => {
    const insertion = hunk(['+x'], 9, 0, 10, 1)
    expect(unchangedBefore(replaced, insertion)).toBe(0)
    expect(unchangedBefore(undefined, insertion)).toBe(9)
  })
})

describe('anchorRow', () => {
  const rows = hunkRows(replaced)

  it('is the last row inside the range, on the range\'s side', () => {
    expect(anchorRow(rows, { startLine: 6, endLine: 7, side: 'new' })).toBe(6)
    expect(anchorRow(rows, { startLine: 6, endLine: 7, side: 'old' })).toBe(4)
    expect(anchorRow(rows, { startLine: 6, endLine: 6, side: 'new' })).toBe(5)
  })

  it('falls back to the end of the hunk when the range is not in it', () => {
    expect(anchorRow(rows, { startLine: 99, endLine: 99, side: 'new' })).toBe(rows.length - 1)
  })
})

describe('noteIndex', () => {
  const rows = hunkRows(replaced)

  it('is the row the comment sits under in the unified layout', () => {
    expect(noteIndex(rows, undefined, { startLine: 6, endLine: 7, side: 'new' })).toBe(6)
  })

  it('is the split row that holds that row in the split layout', () => {
    const split = splitHunkRows(rows)
    // Rows 3 and 4 are removed, 5 and 6 added: they pair up into two split rows after the three context rows.
    expect(noteIndex(rows, split, { startLine: 6, endLine: 7, side: 'new' })).toBe(4)
    expect(noteIndex(rows, split, { startLine: 6, endLine: 7, side: 'old' })).toBe(4)
    expect(noteIndex(rows, split, { startLine: 99, endLine: 99, side: 'new' })).toBe(split.length - 1)
  })
})

describe('excerptOf', () => {
  it('is the first changed line in the range, trimmed and short', () => {
    expect(excerptOf(replaced, { startLine: 7, endLine: 7, side: 'new' })).toBe('extra')
    expect(excerptOf(replaced, { startLine: 6, endLine: 7, side: 'old' })).toBe('six')
    expect(excerptOf(hunk(['+  ' + 'x'.repeat(300)], 1, 0, 1, 1), { startLine: 1, endLine: 1, side: 'new' })).toHaveLength(100)
  })

  it('falls back to the first changed line of the hunk', () => {
    expect(excerptOf(replaced, { startLine: 99, endLine: 99, side: 'new' })).toBe('six')
  })
})

describe('staleReason', () => {
  it('explains each conflict in plain words', () => {
    expect(staleReason('drift')).toMatch(/no longer in the file/)
    expect(staleReason('context_mismatch')).toMatch(/around this hunk have changed/)
  })
})

describe('hunkItems', () => {
  const early = hunk(['-a', '+b'], 2, 1, 2, 1, 'early')
  const late = hunk([' x', '-y', ' z'], 40, 3, 41, 2, 'late')
  const entry = (at: ReviewHunk) => ({ hunk: at, revertId: 'r1' })

  it('puts a hunk that was undone back between the ones around it, whatever the others moved', () => {
    const middle = hunk([' p', '-q', ' r'], 20, 3, 25, 2, 'middle')
    const items = hunkItems([early, late], [entry(middle)])
    expect(items.map((item) => [item.kind, item.hunk.id])).toEqual([['hunk', 'early'], ['undone', 'middle'], ['hunk', 'late']])
    expect(items[1]).toMatchObject({ revertId: 'r1' })
  })

  it('places an insertion after the line its start names and before the next hunk', () => {
    const insertion = hunk(['+new'], 2, 0, 3, 1, 'insertion')
    expect(hunkItems([early, late], [entry(insertion)]).map((item) => item.hunk.id)).toEqual(['early', 'insertion', 'late'])
  })

  it('is just the hunks when nothing was undone', () => {
    expect(hunkItems([late, early], []).map((item) => item.kind)).toEqual(['hunk', 'hunk'])
  })
})

describe('undoneText', () => {
  it('names what was undone in the words of the rest of the panel', () => {
    expect(undoneText({ path: 'src/a/client.ts', status: 'modified' }, [replaced])).toBe('Undid the change at lines 6 to 7 in client.ts.')
    expect(undoneText({ path: 'src/a/client.ts', status: 'modified' }, [removed])).toBe('Put back removed lines 6 to 7 in client.ts.')
    expect(undoneText({ path: 'src/a/client.ts', status: 'modified' }, [replaced, added])).toBe('Undid 2 changes in client.ts.')
  })

  it('says what happened to a file that was created or deleted', () => {
    expect(undoneText({ path: 'src/a/new.ts', status: 'added' }, [added])).toBe('Removed new.ts, the file Cubex created.')
    expect(undoneText({ path: 'src/a/old.ts', status: 'deleted' }, [removed])).toBe('Put back old.ts, the file Cubex deleted.')
  })
})

describe('sameReview', () => {
  const file = (extra: Partial<ReviewFile> = {}): ReviewFile =>
    ({ path: 'a.ts', status: 'modified', added: 2, removed: 2, headHash: 'x'.repeat(64), hunks: [replaced], updatedAt: 5, ...extra })

  it('is true for the same answer twice and false when anything the panel shows differs', () => {
    expect(sameReview([file()], [file()])).toBe(true)
    expect(sameReview([file()], [])).toBe(false)
    expect(sameReview([file()], [file({ headHash: 'y'.repeat(64) })])).toBe(false)
    expect(sameReview([file()], [file({ updatedAt: 6 })])).toBe(false)
    expect(sameReview([file()], [file({ externallyModified: true })])).toBe(false)
    expect(sameReview([file()], [file({ hunks: [{ ...replaced, state: 'accepted' }] })])).toBe(false)
    expect(sameReview([file()], [file({ hunks: [{ ...replaced, id: 'other' }] })])).toBe(false)
    expect(sameReview([file()], [file({ hunks: [] })])).toBe(false)
  })
})
