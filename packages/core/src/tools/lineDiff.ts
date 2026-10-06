/**
 * Minimal line-level diff (LCS) with unchanged-run condensing, for showing what
 * a `write_file` actually changed. Pure + dependency-free so it unit-tests
 * cleanly and runs in the main process.
 */
export interface DiffLine {
  /** '+' added · '-' removed · ' ' context · '@' collapsed-gap marker */
  tag: '+' | '-' | ' ' | '@'
  text: string
}

/** Full LCS diff of two texts, line by line. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  const m = a.length
  const n = b.length

  // Guard against O(m·n) blowup on very large files — fall back to a coarse
  // "replaced N lines with M" summary rather than building a huge table.
  if (m * n > 4_000_000) {
    return [
      { tag: '@', text: `${m} lines replaced with ${n} lines` }
    ]
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ tag: '-', text: a[i]! })
      i++
    } else {
      out.push({ tag: '+', text: b[j]! })
      j++
    }
  }
  while (i < m) out.push({ tag: '-', text: a[i++]! })
  while (j < n) out.push({ tag: '+', text: b[j++]! })
  return out
}

/**
 * Collapse long runs of unchanged context down to `context` lines on each side
 * of a change, inserting a single '@' gap marker for what was hidden. Keeps a
 * diff readable when a small edit lands in a big file.
 */
export function condenseDiff(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.tag === '+' || l.tag === '-' || l.tag === '@') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
        keep[k] = true
      }
    }
  })
  const out: DiffLine[] = []
  let hidden = 0
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (hidden > 0) {
        out.push({ tag: '@', text: `⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}` })
        hidden = 0
      }
      out.push(l)
    } else {
      hidden++
    }
  })
  if (hidden > 0) out.push({ tag: '@', text: `⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}` })
  return out
}

/** Serialize a diff to a compact string: one line per entry, tag as first char. */
export function serializeDiff(lines: DiffLine[]): string {
  return lines.map((l) => l.tag + l.text).join('\n')
}
