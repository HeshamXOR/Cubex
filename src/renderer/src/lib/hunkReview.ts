import { changedRange, numberHunkLines } from '../../../shared/hunkLines'
import type { ReviewComment, ReviewFile, ReviewHunk } from '../../../shared/ipc'
import { emphasizeWords, toSplit, type DiffRow, type SplitRow } from './diffModel'
import { splitPath } from './format'

/** Where a comment sits in a diff: a line range on one side of it. */
export type CommentRange = Pick<ReviewComment, 'startLine' | 'endLine' | 'side'>

/** The rows of one hunk, numbered on both sides, with the words that changed marked. */
export function hunkRows(hunk: ReviewHunk): DiffRow[] {
  const rows: DiffRow[] = numberHunkLines(hunk).map((line) => ({
    kind: line.tag === '+' ? 'add' : line.tag === '-' ? 'del' : 'ctx',
    text: line.text,
    ...(line.oldNo !== undefined ? { oldNo: line.oldNo } : {}),
    ...(line.newNo !== undefined ? { newNo: line.newNo } : {})
  }))
  emphasizeWords(rows)
  return rows
}

/**
 * What a comment on the whole hunk covers: the lines it changed. A hunk that only removes lines is
 * commented on the old side, because those lines are not in the new file.
 */
export function hunkAnchor(hunk: ReviewHunk): CommentRange {
  if (hunk.lines.some((line) => line[0] === '+')) {
    const { start, end } = changedRange(hunk)
    return { startLine: start, endLine: end, side: 'new' }
  }
  const removed = numberHunkLines(hunk).flatMap((line) => (line.tag === '-' && line.oldNo !== undefined ? [line.oldNo] : []))
  if (!removed.length) return { startLine: hunk.newStart, endLine: hunk.newStart, side: 'new' }
  return { startLine: removed[0]!, endLine: removed[removed.length - 1]!, side: 'old' }
}

/** What a comment on one line covers: removed lines are on the old side, everything else on the new. */
export function rowRange(row: DiffRow): CommentRange | undefined {
  if (row.kind === 'del') return row.oldNo === undefined ? undefined : { startLine: row.oldNo, endLine: row.oldNo, side: 'old' }
  return row.newNo === undefined ? undefined : { startLine: row.newNo, endLine: row.newNo, side: 'new' }
}

/** "Lines 12 to 18", "Removed line 5": the words the model also finds in the message it is sent. */
export function describeRange(range: CommentRange): string {
  const single = range.startLine === range.endLine
  const where = single ? `${range.startLine}` : `${range.startLine} to ${range.endLine}`
  if (range.side === 'old') return `Removed ${single ? 'line' : 'lines'} ${where}`
  return `${single ? 'Line' : 'Lines'} ${where}`
}

/** The same words in the middle of a sentence: "lines 12 to 18". */
export function describeRangeInline(range: CommentRange): string {
  const text = describeRange(range)
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`
}

/** Unchanged lines between two neighboring hunks of a file, or above the first one when `previous` is absent. */
export function unchangedBefore(previous: ReviewHunk | undefined, hunk: ReviewHunk): number {
  // A side with no lines has a start that is the line before the gap, so its first line is one after it.
  const first = hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1
  const lastOfPrevious = previous ? (previous.oldLines > 0 ? previous.oldStart + previous.oldLines - 1 : previous.oldStart) : 0
  return Math.max(0, first - lastOfPrevious - 1)
}

/** The index of the row a comment is shown under: the last row inside its range, or the end of the hunk when none is. */
export function anchorRow(rows: readonly DiffRow[], range: CommentRange): number {
  let at = -1
  rows.forEach((row, index) => {
    const no = range.side === 'new' ? row.newNo : row.oldNo
    if (no !== undefined && no >= range.startLine && no <= range.endLine) at = index
  })
  return at >= 0 ? at : rows.length - 1
}

/** The rows of a hunk side by side: each removed line beside the line that replaced it. */
export function splitHunkRows(rows: readonly DiffRow[]): SplitRow[] {
  return toSplit(rows).filter((item): item is SplitRow => item.kind === 'row')
}

/** Where a comment on `range` goes among the rows of the layout in use: the unified rows, or the split rows when there are any. */
export function noteIndex(rows: readonly DiffRow[], split: readonly SplitRow[] | undefined, range: CommentRange): number {
  const at = anchorRow(rows, range)
  if (!split) return at
  const row = rows[at]
  const index = split.findIndex((item) => item.left === row || item.right === row)
  return index >= 0 ? index : split.length - 1
}

/** The first changed line a range covers, short enough for a list; the tray shows it after the hunk is gone. */
export function excerptOf(hunk: ReviewHunk, range: CommentRange): string {
  const lines = numberHunkLines(hunk)
  const inside = lines.find((line) => {
    const no = range.side === 'new' ? line.newNo : line.oldNo
    return line.tag !== ' ' && no !== undefined && no >= range.startLine && no <= range.endLine
  })
  const line = inside ?? lines.find((candidate) => candidate.tag !== ' ')
  return line ? line.text.trim().slice(0, 100) : ''
}

/** Why a hunk could not be undone, in the words the person reads on the hunk. */
export function staleReason(reason: 'drift' | 'context_mismatch'): string {
  return reason === 'drift'
    ? 'The lines this hunk added are no longer in the file, so there is nothing to undo here.'
    : 'The lines around this hunk have changed since Cubex wrote it, so undoing it could damage your edits.'
}

/** What the panel lists for a file: the hunks still in it, and in their own place the ones undone this session. */
export type HunkItem<U extends { hunk: ReviewHunk }> = { kind: 'hunk'; hunk: ReviewHunk } | ({ kind: 'undone' } & U)

/** Where a hunk sits among the lines of the file as it was before Cubex changed it, which undoing another hunk does not move. */
function baselineAt(hunk: ReviewHunk): number {
  // A hunk with no old lines sits between two lines: the one its start names and the next.
  return hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 0.5
}

/** The hunks of a file in order, with each hunk that was undone this session back in its own place. */
export function hunkItems<U extends { hunk: ReviewHunk }>(hunks: readonly ReviewHunk[], undone: readonly U[]): Array<HunkItem<U>> {
  const items: Array<HunkItem<U>> = [
    ...hunks.map((hunk) => ({ kind: 'hunk' as const, hunk })),
    ...undone.map((entry) => ({ kind: 'undone' as const, ...entry }))
  ]
  return items.sort((a, b) => baselineAt(a.hunk) - baselineAt(b.hunk))
}

/** What to tell the person once hunks of a file were undone. */
export function undoneText(file: Pick<ReviewFile, 'path' | 'status'>, hunks: readonly ReviewHunk[]): string {
  const { name } = splitPath(file.path)
  if (file.status === 'added') return `Removed ${name}, the file Cubex created.`
  if (file.status === 'deleted') return `Put back ${name}, the file Cubex deleted.`
  if (hunks.length !== 1) return `Undid ${hunks.length} changes in ${name}.`
  const range = hunkAnchor(hunks[0]!)
  const where = describeRangeInline(range)
  return range.side === 'old' ? `Put back ${where} in ${name}.` : `Undid the change at ${where} in ${name}.`
}

/** Whether two answers describe the same review, so a refetch that found nothing new does not redraw it. */
export function sameReview(a: readonly ReviewFile[], b: readonly ReviewFile[]): boolean {
  if (a.length !== b.length) return false
  return a.every((file, index) => {
    const other = b[index]!
    return file.path === other.path && file.headHash === other.headHash && file.status === other.status &&
      file.added === other.added && file.removed === other.removed && file.updatedAt === other.updatedAt &&
      !!file.binary === !!other.binary && !!file.oversize === !!other.oversize && !!file.formatChanged === !!other.formatChanged &&
      !!file.externallyModified === !!other.externallyModified && (file.hunksOmitted ?? 0) === (other.hunksOmitted ?? 0) &&
      file.hunks.length === other.hunks.length && file.hunks.every((hunk, at) => hunk.id === other.hunks[at]!.id && hunk.state === other.hunks[at]!.state)
  })
}
