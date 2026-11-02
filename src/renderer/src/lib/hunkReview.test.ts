import { describe, expect, it } from 'vitest'
import type { ReviewHunk } from '../../../shared/ipc'
import { describeRange, hunkAnchor, hunkItems, hunkRows, unchangedBefore } from './hunkReview'

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

describe('describeRange', () => {
  it('says what the message to the model says', () => {
    expect(describeRange({ startLine: 14, endLine: 14, side: 'new' })).toBe('Line 14')
    expect(describeRange({ startLine: 12, endLine: 18, side: 'new' })).toBe('Lines 12 to 18')
    expect(describeRange({ startLine: 5, endLine: 5, side: 'old' })).toBe('Removed line 5')
    expect(describeRange({ startLine: 5, endLine: 7, side: 'old' })).toBe('Removed lines 5 to 7')
  })

})

describe('unchangedBefore', () => {
  it('counts the lines above the first hunk and between hunks', () => {
    expect(unchangedBefore(undefined, replaced)).toBe(2)
    expect(unchangedBefore(undefined, added)).toBe(0)
    const later = hunk([' a', '-b', ' c'], 20, 3, 22, 2)
    expect(unchangedBefore(replaced, later)).toBe(20 - 10 - 1)
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
