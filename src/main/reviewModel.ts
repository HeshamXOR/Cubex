import { createHash } from 'node:crypto'
import { lineDiff } from '@core/tools/lineDiff'
import type { ReviewFile, ReviewHunk } from '@shared/ipc'
import { analyzeText, withEol, type TextView } from './tools/textEdit'

/**
 * Pure hunk model for the review panel: no file access. A file's text is a list
 * of '\n'-separated segments, so the final newline is a real (empty) last segment
 * and every edit, including one that only toggles it, reverses exactly. When both
 * sides end with a newline that shared segment is dropped from the diff, so it is
 * never shown as a line. Hunks are computed on the LF-normalized, BOM-free text;
 * reversing splices into the ORIGINAL text so untouched bytes keep their endings.
 */

export const REVIEW_CONTEXT_LINES = 3
export const REVIEW_MAX_HUNKS = 200
export const REVIEW_MAX_BYTES = 2 * 1024 * 1024
/** lineDiff builds an m by n table; past this the diff is not attempted. */
const MAX_DIFF_CELLS = 4_000_000

export interface BuildReviewOptions {
  context?: number
  maxHunks?: number
  /** Either side longer than this is reviewed per file only. */
  maxBytes?: number
  headHash?: string | null
  /** The caller found the bytes are not UTF-8 text. */
  binary?: boolean
  externallyModified?: boolean
  updatedAt?: number
}

type Op = { tag: '+' | '-' | ' '; text: string }

/** The segments each side contributes to the diff (see the module comment). */
function sides(before: string | null, after: string | null): { a: string[]; b: string[] } {
  const a = before === null ? [] : before.split('\n')
  const b = after === null ? [] : after.split('\n')
  const shared = before !== null && after !== null && a[a.length - 1] === '' && b[b.length - 1] === ''
  if (shared) { a.pop(); b.pop() }
  else if (before === null && b[b.length - 1] === '') b.pop()
  else if (after === null && a[a.length - 1] === '') a.pop()
  return { a, b }
}

interface Diff {
  /** Ops with at most `context` unchanged lines kept on each end. */
  ops: Op[]
  /** Lines of each side before ops[0]. */
  oldBase: number
  newBase: number
}

/** LCS diff of the changed middle only; the unchanged ends are trimmed to their context first. */
function diffSides(a: string[], b: string[], context: number): Diff | undefined {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  if ((endA - start) * (endB - start) > MAX_DIFF_CELLS) return undefined
  // lineDiff takes text: a one-character prefix keeps a lone empty line from reading as "no lines".
  const joined = (lines: string[]): string => lines.map((line) => `\u0001${line}`).join('\n')
  const middle = lineDiff(joined(a.slice(start, endA)), joined(b.slice(start, endB)))
  if (middle.some((line) => line.tag === '@')) return undefined
  const lead = a.slice(Math.max(0, start - context), start)
  const tail = a.slice(endA, Math.min(a.length, endA + context))
  const ctx = (text: string): Op => ({ tag: ' ', text })
  return {
    ops: [...lead.map(ctx), ...middle.map((line) => ({ tag: line.tag as Op['tag'], text: line.text.slice(1) })), ...tail.map(ctx)],
    oldBase: start - lead.length,
    newBase: start - lead.length
  }
}

const hunkId = (path: string, lines: string[]): string => createHash('sha1').update(`${path}\n${lines.join('\n')}`).digest('hex')

/** Group changes into hunks: runs of changes at most 2 * context unchanged lines apart share one. */
function makeHunks(path: string, diff: Diff, context: number): ReviewHunk[] {
  const { ops } = diff
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let o = diff.oldBase
  let n = diff.newBase
  for (const op of ops) {
    oldBefore.push(o)
    newBefore.push(n)
    if (op.tag !== '+') o++
    if (op.tag !== '-') n++
  }
  const changed = ops.flatMap((op, i) => (op.tag === ' ' ? [] : [i]))
  const hunks: ReviewHunk[] = []
  const seen = new Map<string, number>()
  for (let at = 0; at < changed.length;) {
    let last = at
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! - 1 <= 2 * context) last++
    const from = Math.max(0, changed[at]! - context)
    const to = Math.min(ops.length - 1, changed[last]! + context)
    const slice = ops.slice(from, to + 1)
    const lines = slice.map((op) => op.tag + op.text)
    const oldLines = slice.filter((op) => op.tag !== '+').length
    const newLines = slice.filter((op) => op.tag !== '-').length
    const oldStart = oldLines ? oldBefore[from]! + 1 : oldBefore[from]!
    const newStart = newLines ? newBefore[from]! + 1 : newBefore[from]!
    // Identical bodies in one file (repeated blocks) get an occurrence number so ids stay unique.
    const base = hunkId(path, lines)
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    hunks.push({
      id: occurrence ? hunkId(path, [...lines, `#${occurrence}`]) : base,
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      oldStart, oldLines, newStart, newLines, lines, state: 'pending'
    })
    at = last + 1
  }
  return hunks
}

function fileStatus(before: string | null, after: string | null): ReviewFile['status'] {
  return before === null ? 'added' : after === null ? 'deleted' : 'modified'
}

/** A file listed without hunks: binary, oversize or otherwise reviewed per file. */
export function reviewFileLevel(path: string, before: string | null, after: string | null, opts: BuildReviewOptions & { oversize?: boolean } = {}): ReviewFile {
  return {
    path, status: fileStatus(before, after), added: 0, removed: 0, headHash: opts.headHash ?? null, hunks: [],
    ...(opts.binary ? { binary: true } : {}),
    ...(opts.oversize ? { oversize: true } : {}),
    ...(opts.externallyModified ? { externallyModified: true } : {}),
    ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {})
  }
}

/** The review model of one file: hunks of the change from `before` to `after` (null means absent). */
export function buildReviewFile(path: string, before: string | null, after: string | null, opts: BuildReviewOptions = {}): ReviewFile {
  const maxBytes = opts.maxBytes ?? REVIEW_MAX_BYTES
  if (opts.binary || before?.includes('\0') || after?.includes('\0')) return reviewFileLevel(path, before, after, { ...opts, binary: true })
  if ((before?.length ?? 0) > maxBytes || (after?.length ?? 0) > maxBytes) return reviewFileLevel(path, before, after, { ...opts, oversize: true })
  const context = opts.context ?? REVIEW_CONTEXT_LINES
  const viewBefore = before === null ? undefined : analyzeText(before)
  const viewAfter = after === null ? undefined : analyzeText(after)
  const { a, b } = sides(viewBefore?.normalized ?? null, viewAfter?.normalized ?? null)
  const diff = diffSides(a, b, context)
  if (!diff) return reviewFileLevel(path, before, after, { ...opts, oversize: true })
  const all = makeHunks(path, diff, context)
  const max = opts.maxHunks ?? REVIEW_MAX_HUNKS
  const count = (tag: '+' | '-'): number => diff.ops.filter((op) => op.tag === tag).length
  const formatChanged = !!viewBefore && !!viewAfter && (viewBefore.eol !== viewAfter.eol || viewBefore.hasBom !== viewAfter.hasBom) &&
    viewBefore.normalized === viewAfter.normalized
  return {
    path, status: fileStatus(before, after), added: count('+'), removed: count('-'), headHash: opts.headHash ?? null,
    hunks: all.slice(0, max),
    ...(all.length > max ? { hunksOmitted: all.length - max } : {}),
    ...(formatChanged ? { formatChanged: true } : {}),
    ...(opts.externallyModified ? { externallyModified: true } : {}),
    ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {})
  }
}

// The renderer needs the same range to anchor a comment on a whole hunk, so the code lives in shared.
export { changedRange } from '@shared/hunkLines'

// --- Reversing hunks ------------------------------------------------------------

export type ReverseResult =
  | { ok: true; text: string; /** Context lines ignored at each end to find the spot. */ fuzz: number; /** Lines away from where the header says the hunk is. */ offset: number }
  | { ok: false; reason: 'drift' | 'context_mismatch' }

export type ReverseFailure = 'drift' | 'context_mismatch'

const sideLines = (hunk: ReviewHunk, drop: '+' | '-'): string[] => hunk.lines.filter((line) => line[0] !== drop).map((line) => line.slice(1))

function edgeContext(lines: readonly string[]): { lead: number; tail: number } {
  let lead = 0
  while (lead < lines.length && lines[lead]![0] === ' ') lead++
  let tail = 0
  while (tail < lines.length - lead && lines[lines.length - 1 - tail]![0] === ' ') tail++
  return { lead, tail }
}

/** Start indexes where `block` matches `segs` exactly. */
function findBlock(segs: readonly string[], block: readonly string[]): number[] {
  const found: number[] = []
  for (let at = 0; at + block.length <= segs.length; at++) {
    let k = 0
    while (k < block.length && segs[at + k] === block[k]) k++
    if (k === block.length) found.push(at)
  }
  return found
}

/** Replace segments [i, j) by `repl`, keeping every other byte (endings, BOM) of the original text. */
function spliceSegments(view: TextView, segs: readonly string[], i: number, j: number, repl: readonly string[]): string {
  const n = segs.length
  const starts: number[] = []
  let at = 0
  for (const seg of segs) { starts.push(at); at += seg.length + 1 }
  const endOf = (k: number): number => starts[k]! + segs[k]!.length
  let from = 0
  let to = 0
  let text = ''
  if (j > i && repl.length) { from = starts[i]!; to = endOf(j - 1); text = repl.join('\n') }
  else if (j > i) {
    // Removing segments also removes one newline: the one after them, or before them at the end of the text.
    if (j < n) { from = starts[i]!; to = starts[j]! }
    else { from = i > 0 ? endOf(i - 1) : 0; to = endOf(n - 1) }
  } else if (repl.length) {
    if (i < n) { from = to = starts[i]!; text = `${repl.join('\n')}\n` }
    else { from = to = endOf(n - 1); text = `\n${repl.join('\n')}` }
  }
  const body = view.body.slice(0, view.toBody(from)) + withEol(text, view.eol) + view.body.slice(view.toBody(to))
  return (view.hasBom ? String.fromCharCode(0xfeff) : '') + body
}

/**
 * Undo one hunk in the CURRENT text: find its new-side lines (context plus added lines)
 * and put the old-side lines back. `fuzz: 3` retries with up to 1, 2, then 3 context lines
 * ignored at each end. A match away from the header's line is reported as an offset; an
 * ambiguous match is refused. Only the matched lines change, so a user's edits elsewhere,
 * and the file's endings and BOM, are kept.
 *  - drift: the lines the hunk added are no longer there (edited, moved away, or the file was replaced).
 *  - context_mismatch: they are, but the lines around them differ more than the fuzz allows.
 */
export function reverseHunk(currentText: string, hunk: ReviewHunk, options: { fuzz?: 0 | 3 } = {}): ReverseResult {
  const view = analyzeText(currentText)
  const segs = view.normalized.split('\n')
  const newBlock = sideLines(hunk, '-')
  const oldBlock = sideLines(hunk, '+')
  const { lead, tail } = edgeContext(hunk.lines)
  let tried = ''
  for (let fuzz = 0; fuzz <= (options.fuzz ?? 0); fuzz++) {
    const head = Math.min(fuzz, lead)
    const foot = Math.min(fuzz, tail)
    if (`${head},${foot}` === tried) continue
    tried = `${head},${foot}`
    const find = newBlock.slice(head, newBlock.length - foot)
    const put = oldBlock.slice(head, oldBlock.length - foot)
    if (!find.length) {
      // Nothing to anchor on: only an emptied file has a known place for restored lines.
      if (!newBlock.length && view.normalized === '') return { ok: true, text: spliceSegments(view, segs, 0, 0, put), fuzz, offset: 0 }
      continue
    }
    const found = findBlock(segs, find)
    const expected = hunk.newStart - 1 + head
    const at = found.includes(expected) ? expected : found.length === 1 ? found[0]! : undefined
    if (at !== undefined) return { ok: true, text: spliceSegments(view, segs, at, at + find.length, put), fuzz, offset: at - expected }
  }
  const added = hunk.lines.flatMap((line, k) => (line[0] === '+' ? [k] : []))
  if (!added.length) return { ok: false, reason: 'context_mismatch' }
  const core = hunk.lines.slice(added[0]!, added[added.length - 1]! + 1).filter((line) => line[0] !== '-').map((line) => line.slice(1))
  return { ok: false, reason: findBlock(segs, core).length ? 'context_mismatch' : 'drift' }
}

export interface ReverseManyResult {
  text: string
  applied: Array<{ id: string; fuzz: number; offset: number }>
  conflicts: Array<{ id: string; reason: ReverseFailure }>
}

/** Undo several hunks, bottom first so the line numbers of the ones above stay valid. A conflict leaves that hunk's lines as they are. */
export function reverseHunks(currentText: string, hunks: readonly ReviewHunk[], options: { fuzz?: 0 | 3 } = {}): ReverseManyResult {
  const result: ReverseManyResult = { text: currentText, applied: [], conflicts: [] }
  for (const hunk of [...hunks].sort((x, y) => y.newStart - x.newStart)) {
    const outcome = reverseHunk(result.text, hunk, options)
    if (outcome.ok) {
      result.text = outcome.text
      result.applied.push({ id: hunk.id, fuzz: outcome.fuzz, offset: outcome.offset })
    } else result.conflicts.push({ id: hunk.id, reason: outcome.reason })
  }
  return result
}
