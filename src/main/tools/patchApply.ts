import { analyzeText, reportClosestRegion } from './textEdit'
import type { PatchChunk, PatchHunkLine } from './patchFormat'

/**
 * Apply the hunks of one "Update File" operation to a file's text.
 *
 * Hunks are located by their context and removed lines, searching forward from the
 * previous hunk (Codex/OpenAI semantics), with a whitespace-insensitive fallback for
 * small drifts. The file's own context lines are kept exactly as they are, so a fuzzy
 * match never rewrites indentation or line endings the patch did not mean to change.
 * Each line keeps its own ending; new lines use the dominant one.
 */

const BOM = String.fromCharCode(0xfeff)

interface Line {
  text: string
  /** '' only for an unterminated last line. */
  eol: string
}

export interface AppliedChunk {
  /** The file's own text that the hunk replaced (LF-normalized); '' for a pure insertion. */
  oldText: string
  /** The text now in its place. */
  newText: string
  /** A pure insertion positioned after an @@ anchor line. */
  anchored: boolean
  anchorText?: string
}

export type ApplyChunksResult =
  | {
      ok: true
      /** Complete new file text, including the BOM and original endings. */
      text: string
      /** BOM-stripped, LF-normalized before/after text for diffs. */
      before: string
      after: string
      chunks: AppliedChunk[]
    }
  | { ok: false; error: string }

function splitLines(body: string): Line[] {
  const lines: Line[] = []
  let start = 0
  const ending = /\r?\n/g
  for (let match = ending.exec(body); match; match = ending.exec(body)) {
    lines.push({ text: body.slice(start, match.index), eol: match[0] })
    start = match.index + match[0].length
  }
  if (start < body.length) lines.push({ text: body.slice(start), eol: '' })
  return lines
}

/** A regex character class from code point ranges, kept ASCII-only so no invisible characters live in the source. */
function characterClass(...ranges: Array<[number, number]>): RegExp {
  return new RegExp(`[${ranges.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g')
}
const DASHES = characterClass([0x2010, 0x2015], [0x2212, 0x2212])
const SINGLE_QUOTES = characterClass([0x2018, 0x201b])
const DOUBLE_QUOTES = characterClass([0x201c, 0x201f])
const UNUSUAL_SPACES = characterClass([0xa0, 0xa0], [0x2002, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000])

/** Typographic dashes, quotes and spaces folded to ASCII, whitespace runs collapsed. */
function squashPunctuation(text: string): string {
  return text
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(UNUSUAL_SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strictest to loosest; the first pass that matches anywhere wins. */
const PASSES: ReadonlyArray<(line: string) => string> = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
  squashPunctuation
]

function trimBlankContext(lines: readonly PatchHunkLine[]): PatchHunkLine[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.kind === 'context' && lines[start]!.text.trim() === '') start++
  while (end > start && lines[end - 1]!.kind === 'context' && lines[end - 1]!.text.trim() === '') end--
  return lines.slice(start, end)
}

interface Replacement {
  start: number
  length: number
  inserted: Line[]
}

export function applyChunks(text: string, chunks: readonly PatchChunk[]): ApplyChunksResult {
  const view = analyzeText(text)
  const lines = splitLines(view.body)
  const eol = view.eol
  const hadTrailingNewline = lines.length === 0 || lines[lines.length - 1]!.eol !== ''
  const failure = (message: string): ApplyChunksResult => ({ ok: false, error: message })

  const cache: Array<string[] | undefined> = []
  const normalizedLines = (pass: number): string[] => (cache[pass] ??= lines.map((line) => PASSES[pass]!(line.text)))

  /** First position at or after `from` where the pattern matches, by the strictest pass that finds one. */
  const seek = (pattern: readonly string[], from: number, endOfFile: boolean): number => {
    if (pattern.length === 0 || pattern.length > lines.length) return -1
    for (let pass = 0; pass < PASSES.length; pass++) {
      const haystack = normalizedLines(pass)
      const want = pattern.map(PASSES[pass]!)
      const matchesAt = (start: number): boolean => want.every((line, offset) => haystack[start + offset] === line)
      if (endOfFile) {
        const tail = lines.length - pattern.length
        if (tail >= from && matchesAt(tail)) return tail
      }
      for (let start = from; start + pattern.length <= lines.length; start++) {
        if (haystack[start] === want[0] && matchesAt(start)) return start
      }
    }
    return -1
  }

  const seekAnchor = (anchor: string, from: number): number => {
    for (let pass = 0; pass < PASSES.length; pass++) {
      const haystack = normalizedLines(pass)
      const want = PASSES[pass]!(anchor)
      for (let at = from; at < lines.length; at++) if (haystack[at] === want) return at
    }
    // Models abbreviate: "@@ def compute" for "def compute(a, b):".
    const want = squashPunctuation(anchor)
    const haystack = normalizedLines(PASSES.length - 1)
    for (let at = from; at < lines.length && want; at++) if (haystack[at]!.startsWith(want)) return at
    return -1
  }

  const replacements: Replacement[] = []
  const applied: AppliedChunk[] = []
  let cursor = 0
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!
    const name = `hunk ${index + 1}`
    let anchorLine = -1
    for (const anchor of chunk.anchors) {
      const found = seekAnchor(anchor, cursor)
      if (found < 0) {
        const report = reportClosestRegion(view.normalized, anchor, 'the anchor')
        return failure([
          `${name}: the anchor line "@@ ${anchor}" was not found${cursor > 0 ? ` after line ${cursor}` : ''}.`,
          ...(report ? report.lines : []),
          'Use a line that appears in the file (or a distinctive prefix of one) after the previous hunk, or drop the anchor.'
        ].join('\n'))
      }
      anchorLine = found
      cursor = found + 1
    }

    const added = (used: readonly PatchHunkLine[]): Line[] => used.filter((line) => line.kind === 'add').map((line) => ({ text: line.text, eol }))
    const oldPattern = (used: readonly PatchHunkLine[]): string[] => used.filter((line) => line.kind !== 'add').map((line) => line.text)

    if (oldPattern(chunk.lines).length === 0) {
      // Pure insertion: right after the anchor, or at the end of the file without one.
      const at = chunk.anchors.length > 0 ? cursor : lines.length
      const inserted = added(chunk.lines)
      replacements.push({ start: at, length: 0, inserted })
      applied.push({
        oldText: '',
        newText: inserted.map((line) => line.text).join('\n'),
        anchored: anchorLine >= 0,
        ...(anchorLine >= 0 ? { anchorText: lines[anchorLine]!.text } : {})
      })
      cursor = at
      continue
    }

    let used: readonly PatchHunkLine[] = chunk.lines
    let found = seek(oldPattern(used), cursor, chunk.endOfFile)
    if (found < 0) {
      // A blank context line at an edge of the hunk is often an artifact of the file's final newline.
      const trimmed = trimBlankContext(chunk.lines)
      if (trimmed.length !== chunk.lines.length && oldPattern(trimmed).length > 0) {
        found = seek(oldPattern(trimmed), cursor, chunk.endOfFile)
        if (found >= 0) used = trimmed
      }
    }
    if (found < 0) {
      const pattern = oldPattern(chunk.lines)
      const earlier = seek(pattern, 0, chunk.endOfFile)
      if (earlier >= 0 && earlier < cursor) {
        return failure(`${name} matches lines ${earlier + 1}-${earlier + pattern.length}, which come before the previous hunk. Hunks must follow the order of the file.`)
      }
      const report = reportClosestRegion(view.normalized, pattern.join('\n'), 'the hunk')
      return failure([
        `${name} does not match the file. Its context and removed lines must appear in the file, in file order, after the previous hunk.`,
        ...(report ? report.lines : ['No similar text was found in the file. Re-read it with read_file and copy the lines exactly.']),
        ...(report ? ['Copy the file text exactly (without the "N: " prefixes) into the hunk, or re-read the file with read_file.'] : [])
      ].join('\n'))
    }

    // Walk the hunk: context lines are the file's own lines, removed lines are dropped, added lines are new.
    const inserted: Line[] = []
    let position = found
    for (const line of used) {
      if (line.kind === 'context') inserted.push(lines[position++]!)
      else if (line.kind === 'remove') position++
      else inserted.push({ text: line.text, eol })
    }
    const length = position - found
    replacements.push({ start: found, length, inserted })
    applied.push({
      oldText: lines.slice(found, position).map((line) => line.text).join('\n'),
      newText: inserted.map((line) => line.text).join('\n'),
      anchored: false
    })
    cursor = position
  }

  const out: Line[] = []
  let copied = 0
  for (const replacement of replacements) {
    for (let at = copied; at < replacement.start; at++) out.push(lines[at]!)
    for (const line of replacement.inserted) out.push(line)
    copied = replacement.start + replacement.length
  }
  for (let at = copied; at < lines.length; at++) out.push(lines[at]!)

  // Every line but the last needs a terminator; the last keeps the file's final-newline state.
  for (let at = 0; at < out.length - 1; at++) if (out[at]!.eol === '') out[at] = { text: out[at]!.text, eol }
  if (out.length > 0) {
    const last = out[out.length - 1]!
    const wanted = hadTrailingNewline ? last.eol || eol : ''
    if (last.eol !== wanted) out[out.length - 1] = { text: last.text, eol: wanted }
  }

  const body = out.map((line) => line.text + line.eol).join('')
  const next = (view.hasBom ? BOM : '') + body
  if (next === text) return failure('the hunks leave the file unchanged.')
  return {
    ok: true,
    text: next,
    before: view.normalized,
    after: out.map((line) => line.text + (line.eol ? '\n' : '')).join(''),
    chunks: applied
  }
}
