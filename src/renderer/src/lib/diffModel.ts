/**
 * Turns the serialized line diff the main process produces (one entry per line,
 * the tag as its first character: '+' added, '-' removed, ' ' context, '@' a
 * collapsed run of unchanged lines) into rows with line numbers, hunks and
 * word-level emphasis, for the review panel and the inline transcript diff.
 */

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx'
  oldNo?: number
  newNo?: number
  text: string
  /** Character ranges [start, end) of `text` that changed within the line. */
  marks?: Array<[number, number]>
}

export interface DiffGap {
  kind: 'gap'
  /** Unchanged lines that were collapsed; 0 for a plain notice. */
  hidden: number
  text: string
}

export interface DiffHunk {
  kind: 'hunk'
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
}

export type DiffItem = DiffRow | DiffGap | DiffHunk

const UNCHANGED = /(\d+)\s+unchanged/
/** Word diffs on very long lines cost more than they tell. */
const MAX_TOKENS = 160
/** A pair of lines that shares less than this is shown as wholly replaced, with no word emphasis. */
const MIN_SHARED = 0.3

export function parseDiff(serialized: string): DiffItem[] {
  if (!serialized) return []
  const items: DiffItem[] = []
  let oldNo = 1
  let newNo = 1
  let hunk: DiffHunk | undefined

  const open = (): void => {
    if (hunk) return
    hunk = { kind: 'hunk', oldStart: oldNo, oldLines: 0, newStart: newNo, newLines: 0, header: '' }
    items.push(hunk)
  }
  const close = (): void => {
    if (!hunk) return
    hunk.header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    hunk = undefined
  }

  for (const line of serialized.split('\n')) {
    const tag = line[0]
    const text = line.slice(1)
    if (tag === '@') {
      close()
      const hidden = Number(UNCHANGED.exec(text)?.[1] ?? 0)
      items.push({ kind: 'gap', hidden, text: hidden ? `${hidden} unchanged ${hidden === 1 ? 'line' : 'lines'}` : text.replace(/^⋯\s*/, '') })
      oldNo += hidden
      newNo += hidden
      continue
    }
    open()
    if (tag === '+') {
      items.push({ kind: 'add', newNo, text })
      newNo++
      hunk!.newLines++
    } else if (tag === '-') {
      items.push({ kind: 'del', oldNo, text })
      oldNo++
      hunk!.oldLines++
    } else {
      // A space is context. An untagged line should not occur; show it rather than lose it.
      items.push({ kind: 'ctx', oldNo, newNo, text: tag === ' ' ? text : line })
      oldNo++
      newNo++
      hunk!.oldLines++
      hunk!.newLines++
    }
  }
  close()
  emphasizeWords(items)
  return items
}

export function diffStats(items: readonly DiffItem[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const item of items) {
    if (item.kind === 'add') added++
    else if (item.kind === 'del') removed++
  }
  return { added, removed }
}

/** Mark the words that changed between each removed line and the added line that replaces it. */
export function emphasizeWords(items: DiffItem[]): void {
  let removed: DiffRow[] = []
  let added: DiffRow[] = []
  const flush = (): void => {
    const pairs = Math.min(removed.length, added.length)
    for (let index = 0; index < pairs; index++) {
      const marks = wordMarks(removed[index]!.text, added[index]!.text)
      if (!marks) continue
      if (marks.old.length) removed[index]!.marks = marks.old
      if (marks.new.length) added[index]!.marks = marks.new
    }
    removed = []
    added = []
  }
  for (const item of items) {
    if (item.kind === 'del') {
      if (added.length) flush()
      removed.push(item)
    } else if (item.kind === 'add') {
      added.push(item)
    } else flush()
  }
  flush()
}

const TOKEN = /\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu

interface Token { text: string; start: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(TOKEN)) tokens.push({ text: match[0], start: match.index! })
  return tokens
}

/** Changed character ranges for a pair of lines, or undefined when they are too different to be worth marking. */
export function wordMarks(before: string, after: string): { old: Array<[number, number]>; new: Array<[number, number]> } | undefined {
  if (before === after) return undefined
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return undefined

  // Longest common subsequence of tokens.
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint16Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i]!.text === b[j]!.text
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
    }
  }
  const sameA = new Array<boolean>(a.length).fill(false)
  const sameB = new Array<boolean>(b.length).fill(false)
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) {
      sameA[i] = true
      sameB[j] = true
      i++
      j++
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) i++
    else j++
  }

  const oldRanges = rangesOf(a, sameA)
  const newRanges = rangesOf(b, sameB)
  const sharedChars = a.reduce((total, token, index) => total + (sameA[index] && token.text.trim() ? token.text.length : 0), 0)
  const longest = Math.max(before.trim().length, after.trim().length)
  if (!longest || sharedChars / longest < MIN_SHARED) return undefined
  return { old: oldRanges, new: newRanges }
}

/** Changed tokens as character ranges; unchanged whitespace between two changes joins them. */
function rangesOf(tokens: Token[], same: boolean[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let open: [number, number] | undefined
  let bridgeable = false
  tokens.forEach((token, index) => {
    const end = token.start + token.text.length
    if (!same[index]) {
      if (open && (bridgeable || open[1] === token.start)) open[1] = end
      else {
        open = [token.start, end]
        ranges.push(open)
      }
      bridgeable = false
    } else if (open && !token.text.trim()) {
      bridgeable = true
    } else {
      open = undefined
      bridgeable = false
    }
  })
  return ranges
}

export interface SplitRow { kind: 'row'; left?: DiffRow; right?: DiffRow }
export type SplitItem = SplitRow | DiffGap | DiffHunk

/** Side-by-side rows: context on both sides, and each removed line beside the line that replaced it. */
export function toSplit(items: readonly DiffItem[]): SplitItem[] {
  const out: SplitItem[] = []
  let removed: DiffRow[] = []
  let added: DiffRow[] = []
  const flush = (): void => {
    const count = Math.max(removed.length, added.length)
    for (let index = 0; index < count; index++) out.push({ kind: 'row', left: removed[index], right: added[index] })
    removed = []
    added = []
  }
  for (const item of items) {
    if (item.kind === 'del') {
      if (added.length) flush()
      removed.push(item)
    } else if (item.kind === 'add') {
      added.push(item)
    } else {
      flush()
      if (item.kind === 'gap' || item.kind === 'hunk') out.push(item)
      else out.push({ kind: 'row', left: item, right: item })
    }
  }
  flush()
  return out
}
