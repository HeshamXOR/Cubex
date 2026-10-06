import type { ReviewComment, ReviewHunk } from './ipc'
import { numberHunkLines, type HunkLine } from './hunkLines'

/** One queued comment and, when it is still in the diff, the hunk it was written on. */
export interface CommentOnHunk {
  comment: ReviewComment
  hunk?: ReviewHunk
}

/** A quote longer than this is cut, with a line saying how many were left out. */
const MAX_QUOTE_LINES = 24
const MAX_QUOTE_LINE_LENGTH = 200

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** "Line 14", "Lines 12 to 18", "Removed line 5": the words the model will find in the file or the diff. */
function describeRange(comment: ReviewComment): string {
  const single = comment.startLine === comment.endLine
  const where = single ? `${comment.startLine}` : `${comment.startLine} to ${comment.endLine}`
  if (comment.side === 'old') return `Removed ${single ? 'line' : 'lines'} ${where}`
  return `${single ? 'Line' : 'Lines'} ${where}`
}

/**
 * The lines to quote. A comment that covers every changed line on its side is about the hunk, so the
 * whole hunk is quoted, context included. A narrower comment gets its own lines plus any lines of the
 * other side between them, which belong to the same edit.
 */
function quoteFor(comment: ReviewComment, hunk: ReviewHunk): HunkLine[] {
  const rows = numberHunkLines(hunk)
  const key = comment.side === 'new' ? 'newNo' : 'oldNo'
  const inRange = (row: HunkLine): boolean => {
    const no = row[key]
    return no !== undefined && no >= comment.startLine && no <= comment.endLine
  }
  const changed = rows.filter((row) => row.tag !== ' ' && row[key] !== undefined)
  if (changed.length && changed.every(inRange)) return rows
  const inside = rows.filter(inRange)
  if (!inside.length) return rows
  return rows.slice(rows.indexOf(inside[0]!), rows.indexOf(inside[inside.length - 1]!) + 1)
}

function quoteBlock(rows: readonly HunkLine[]): string[] {
  const shown = rows.slice(0, MAX_QUOTE_LINES).map((row) => {
    const text = row.text.length > MAX_QUOTE_LINE_LENGTH ? `${row.text.slice(0, MAX_QUOTE_LINE_LENGTH)}…` : row.text
    return row.tag + text
  })
  if (rows.length > MAX_QUOTE_LINES) shown.push(`@@ ${plural(rows.length - MAX_QUOTE_LINES, 'more line')} @@`)
  // A fence longer than any run of backticks in the code, so quoted code cannot end the block early.
  const longest = Math.max(0, ...shown.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}diff`, ...shown, fence]
}

/**
 * The one user message that carries a review to the model: each comment with the lines it is about,
 * grouped by file in the order the files were first commented on, then by line. Plain text that reads
 * well in the thread, where the person sees exactly what was sent.
 */
export function formatReviewComments(items: readonly CommentOnHunk[]): string {
  const files = new Map<string, CommentOnHunk[]>()
  for (const item of items) files.set(item.comment.path, [...(files.get(item.comment.path) ?? []), item])

  const lines = [
    `Review comments on your changes: ${plural(items.length, 'comment')} in ${plural(files.size, 'file')}.`,
    '',
    'Address each comment in the file it names. Line numbers are those of the files as they are now. When you are done, say what you changed for each one.'
  ]
  let number = 0
  for (const [path, group] of files) {
    lines.push('', path)
    const ordered = group
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.comment.startLine - b.item.comment.startLine || a.item.comment.endLine - b.item.comment.endLine || a.index - b.index)
    for (const { item } of ordered) {
      lines.push('', `${++number}. ${describeRange(item.comment)}`)
      if (item.hunk) lines.push(...quoteBlock(quoteFor(item.comment, item.hunk)))
      else lines.push('That part of the diff has changed since the comment was written, so no code is quoted.')
      lines.push(item.comment.text.trim())
    }
  }
  return lines.join('\n')
}
