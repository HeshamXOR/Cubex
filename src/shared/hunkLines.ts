import type { ReviewHunk } from './ipc'

/** The part of a hunk that numbering needs. */
type HunkShape = Pick<ReviewHunk, 'lines' | 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>

/** One line of a hunk with its place on both sides of the diff. */
export interface HunkLine {
  tag: ' ' | '+' | '-'
  text: string
  /** 1-based line on the old side; absent for an added line. */
  oldNo?: number
  /** 1-based line on the new side; absent for a removed line. */
  newNo?: number
}

/**
 * A hunk's lines numbered on both sides. A side with no lines has a start that is the line
 * before the gap (as in git), so its numbering would begin one after it; no line uses it then.
 */
export function numberHunkLines(hunk: HunkShape): HunkLine[] {
  let oldNo = hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1
  let newNo = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1
  return hunk.lines.map((line) => {
    const tagged = line[0] === '+' || line[0] === '-' || line[0] === ' '
    const tag = tagged ? (line[0] as HunkLine['tag']) : ' '
    // An untagged line should not occur; keep all of it rather than lose the first character.
    const text = tagged ? line.slice(1) : line
    if (tag === '+') return { tag, text, newNo: newNo++ }
    if (tag === '-') return { tag, text, oldNo: oldNo++ }
    return { tag, text, oldNo: oldNo++, newNo: newNo++ }
  })
}

/** The lines a hunk touches on the new side (1-based, inclusive); a pure deletion reports the line after the gap. */
export function changedRange(hunk: HunkShape): { start: number; end: number } {
  let line = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1
  let start = Infinity
  let end = -Infinity
  for (const text of hunk.lines) {
    if (text[0] !== ' ') { start = Math.min(start, line); end = Math.max(end, line) }
    if (text[0] !== '-') line++
  }
  return start === Infinity ? { start: hunk.newStart, end: hunk.newStart } : { start, end }
}
