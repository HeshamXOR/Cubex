/**
 * Pure text-editing helpers shared by edit_file, multi_edit and apply_patch.
 *
 * Models emit LF and never see a BOM, while real Windows projects mix CRLF, LF and
 * a UTF-8 BOM. An edit therefore matches against an LF-normalized view of the file
 * and is written back by splicing into the ORIGINAL text, so every byte outside the
 * replaced region (endings of untouched lines, the BOM, the final newline) is kept.
 * New line breaks inside a replacement use the file's dominant ending.
 *
 * When a match fails, the error carries a bounded diagnostic (the closest region
 * with line numbers) so the model can retry with exact text.
 */

export type Eol = '\n' | '\r\n'

const BOM = String.fromCharCode(0xfeff)

/** A file's text split into what an edit must preserve and the view used for matching. */
export interface TextView {
  hasBom: boolean
  /** Dominant line ending; LF when LF is at least as common as CRLF. */
  eol: Eol
  /** BOM-stripped text with CRLF folded to LF: what old_string is matched against. */
  normalized: string
  /** BOM-stripped original text. */
  body: string
  /** Index in `body` for an index in `normalized`; a CRLF counts from its CR. */
  toBody(index: number): number
}

/** Number of values strictly below `value` in an ascending list. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid]! < value) low = mid + 1
    else high = mid
  }
  return low
}

export function analyzeText(text: string): TextView {
  const hasBom = text.charCodeAt(0) === 0xfeff
  const body = hasBom ? text.slice(1) : text
  if (!body.includes('\r')) return { hasBom, eol: '\n', normalized: body, body, toBody: (index) => index }
  // crAt[k] is the normalized index of the k-th LF that was preceded by a CR.
  const crAt: number[] = []
  const parts: string[] = []
  let bareLf = 0
  let last = 0
  let length = 0
  for (const match of body.matchAll(/\r?\n/g)) {
    const at = match.index ?? 0
    parts.push(body.slice(last, at), '\n')
    length += at - last
    if (match[0].length === 2) crAt.push(length)
    else bareLf++
    length++
    last = at + match[0].length
  }
  parts.push(body.slice(last))
  return {
    hasBom,
    eol: crAt.length > bareLf ? '\r\n' : '\n',
    normalized: parts.join(''),
    body,
    toBody: (index) => index + countBelow(crAt, index)
  }
}

/** Model-supplied text: CRLF folded to LF, and a leading BOM dropped when the file already has one. */
export function normalizeModelText(text: string, fileHasBom: boolean): string {
  const folded = text.includes('\r') ? text.replace(/\r\n/g, '\n') : text
  return fileHasBom && folded.charCodeAt(0) === 0xfeff ? folded.slice(1) : folded
}

/** LF-normalized text rendered with the given line ending. */
export function withEol(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/** Non-overlapping occurrences, left to right: the same ones replace_all replaces. */
export function findAll(haystack: string, needle: string): number[] {
  const found: number[] = []
  if (!needle) return found
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

export interface EditRequest {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export type EditResult =
  | {
      ok: true
      /** Complete new file text, including the BOM and original endings. */
      text: string
      count: number
      /** BOM-stripped, LF-normalized before/after text for diffs. */
      before: string
      after: string
      /** The normalized strings that were matched and inserted (for read-ledger bookkeeping). */
      oldNormalized: string
      newNormalized: string
    }
  | { ok: false; message: string }

/** Replace `old` with `new` in `text`, preserving endings, BOM and the final newline. */
export function applyEdit(text: string, request: EditRequest, label: string): EditResult {
  const view = analyzeText(text)
  const oldNormalized = normalizeModelText(request.oldString, view.hasBom)
  const newNormalized = normalizeModelText(request.newString, view.hasBom)
  if (!oldNormalized) return { ok: false, message: 'old_string must not be empty.' }
  if (oldNormalized === newNormalized) return { ok: false, message: 'old_string and new_string are identical.' }
  const starts = findAll(view.normalized, oldNormalized)
  if (starts.length === 0) return { ok: false, message: describeNoMatch(view.normalized, oldNormalized, label) }
  if (starts.length > 1 && !request.replaceAll) {
    return { ok: false, message: describeAmbiguous(view.normalized, starts, oldNormalized, label) }
  }
  const insertion = withEol(newNormalized, view.eol)
  const bodyParts: string[] = []
  const afterParts: string[] = []
  let bodyCursor = 0
  let normalizedCursor = 0
  for (const start of starts) {
    const end = start + oldNormalized.length
    bodyParts.push(view.body.slice(bodyCursor, view.toBody(start)), insertion)
    afterParts.push(view.normalized.slice(normalizedCursor, start), newNormalized)
    bodyCursor = view.toBody(end)
    normalizedCursor = end
  }
  bodyParts.push(view.body.slice(bodyCursor))
  afterParts.push(view.normalized.slice(normalizedCursor))
  return {
    ok: true,
    text: (view.hasBom ? BOM : '') + bodyParts.join(''),
    count: starts.length,
    before: view.normalized,
    after: afterParts.join(''),
    oldNormalized,
    newNormalized
  }
}

// --- Diagnostics -------------------------------------------------------------

const MAX_LISTED_MATCHES = 10
const REGION_LINES = 12
const LINE_CLIP = 200
const FUZZY_BUDGET_MS = 40
const FUZZY_MIN_SIMILARITY = 0.55
const MIN_VOTE_WEIGHT = 0.25
const MAX_PROBES = 4

/** 1-based line number of each (ascending) index in `normalized`. */
function lineNumbersAt(normalized: string, indexes: readonly number[]): number[] {
  const lines: number[] = []
  let line = 1
  let scanned = 0
  for (const index of indexes) {
    for (let at = normalized.indexOf('\n', scanned); at >= 0 && at < index; at = normalized.indexOf('\n', scanned)) {
      line++
      scanned = at + 1
    }
    lines.push(line)
  }
  return lines
}

function describeAmbiguous(normalized: string, starts: readonly number[], oldNormalized: string, label: string): string {
  const shown = lineNumbersAt(normalized, starts.slice(0, MAX_LISTED_MATCHES))
  const unique = [...new Set(shown)]
  const more = starts.length - shown.length
  const where = unique.length === 1 ? `line ${unique[0]}` : `lines ${unique.join(', ')}`
  return `old_string appears ${starts.length} times in ${label}, ${oldNormalized.includes('\n') ? 'starting at' : 'at'} ${where}` +
    `${more > 0 ? ` and ${more} more` : ''}. Add more surrounding lines to old_string so it identifies exactly one location, ` +
    'or set replace_all to true to change every occurrence.'
}

function clipLine(line: string): string {
  const flat = line.replace(/\r/g, '')
  return flat.length > LINE_CLIP ? `${flat.slice(0, LINE_CLIP)}…` : flat
}

/** JSON-quoted so tabs, trailing spaces and other invisible differences are visible. */
function visible(line: string): string {
  return JSON.stringify(clipLine(line))
}

const squash = (line: string): string => line.replace(/\s+/g, ' ').trim()

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0xfeff || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000
}

function stripSpaces(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) if (!isSpace(text.charCodeAt(i))) out += text[i]
  return out
}

/** Half-open [start, end) offsets where `needle` occurs once all whitespace is ignored. */
function findIgnoringWhitespace(haystack: string, needle: string): [number, number] | undefined {
  const compact = stripSpaces(needle)
  // A handful of characters would match unrelated code, so claiming a region would mislead.
  if (compact.length < 4) return undefined
  let steps = 0
  for (let at = haystack.indexOf(compact[0]!); at >= 0; at = haystack.indexOf(compact[0]!, at + 1)) {
    let i = at
    let j = 0
    while (i < haystack.length && j < compact.length) {
      if (++steps > 20_000_000) return undefined
      const code = haystack.charCodeAt(i)
      if (isSpace(code)) { i++; continue }
      if (haystack[i] !== compact[j]) break
      i++
      j++
    }
    if (j === compact.length) return [at, i]
  }
  return undefined
}

/** Character-bigram Dice similarity of `probe` against many candidates, without per-call allocation. */
function similarityTo(probe: string): (candidate: string) => number {
  const BUCKETS = 4096
  const base = new Uint16Array(BUCKETS)
  const work = new Uint16Array(BUCKETS)
  const hash = (text: string, at: number): number => (text.charCodeAt(at) * 31 + text.charCodeAt(at + 1)) & (BUCKETS - 1)
  for (let i = 0; i + 1 < probe.length; i++) base[hash(probe, i)]!++
  const probeGrams = Math.max(0, probe.length - 1)
  return (candidate) => {
    if (probe.length < 2 || candidate.length < 2) return probe === candidate ? 1 : 0
    work.set(base)
    let shared = 0
    for (let i = 0; i + 1 < candidate.length; i++) {
      const bucket = hash(candidate, i)
      if (work[bucket]! > 0) { work[bucket]!--; shared++ }
    }
    return (2 * shared) / (probeGrams + candidate.length - 1)
  }
}

interface Region {
  /** 0-based first line and exclusive end line within the file. */
  start: number
  end: number
  /** The whole region matches once whitespace and line breaks are ignored. */
  whitespaceOnly: boolean
}

/** Locate where `needle` most plausibly was meant to match. */
function findClosestRegion(hay: readonly string[], haystack: string, needleLines: readonly string[], needleText: string): Region | undefined {
  const reflowed = findIgnoringWhitespace(haystack, needleText)
  if (reflowed) {
    const [from, to] = reflowed
    const start = lineNumbersAt(haystack, [from])[0]! - 1
    const end = lineNumbersAt(haystack, [Math.max(from, to - 1)])[0]!
    return { start, end, whitespaceOnly: true }
  }
  const hayKeys = hay.map(squash)
  const needleKeys = needleLines.map(squash)
  // Pass 1: lines equal ignoring whitespace vote for the window they would align to,
  // rare and long lines counting more than `}`.
  const counts = new Map<string, number>()
  const positions = new Map<string, number[]>()
  hayKeys.forEach((key, index) => {
    if (!key) return
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const list = positions.get(key)
    if (!list) positions.set(key, [index])
    else if (list.length < 64) list.push(index)
  })
  const votes = new Map<number, number>()
  needleKeys.forEach((key, line) => {
    const where = positions.get(key)
    if (!key || !where) return
    const weight = Math.min(1, key.length / 12) / counts.get(key)!
    for (const index of where) votes.set(index - line, (votes.get(index - line) ?? 0) + weight)
  })
  let bestStart: number | undefined
  let bestWeight = 0
  for (const [start, weight] of votes) {
    if (weight > bestWeight || (weight === bestWeight && bestStart !== undefined && start < bestStart)) { bestStart = start; bestWeight = weight }
  }
  if (bestStart === undefined || bestWeight < MIN_VOTE_WEIGHT) {
    // Pass 2: no line survives whitespace squashing, so look for similar lines (typos, drifted values).
    bestStart = undefined
    bestWeight = 0
    const probes = needleKeys
      .map((key, line) => ({ key, line }))
      .filter((item) => item.key.length >= 4)
      .filter((item, index, all) => all.findIndex((other) => other.key === item.key) === index)
      .sort((a, b) => b.key.length - a.key.length)
      .slice(0, MAX_PROBES)
    const fuzzy = new Map<number, number>()
    const deadline = Date.now() + FUZZY_BUDGET_MS
    for (const probe of probes) {
      const similarity = similarityTo(probe.key)
      let best = FUZZY_MIN_SIMILARITY
      let bestLine = -1
      for (let index = 0; index < hayKeys.length; index++) {
        if ((index & 511) === 0 && Date.now() > deadline) break
        const key = hayKeys[index]!
        if (key.length < 2) continue
        const score = similarity(key)
        if (score > best) { best = score; bestLine = index }
      }
      if (bestLine >= 0) fuzzy.set(bestLine - probe.line, (fuzzy.get(bestLine - probe.line) ?? 0) + best)
    }
    for (const [start, weight] of fuzzy) {
      if (weight > bestWeight || (weight === bestWeight && bestStart !== undefined && start < bestStart)) { bestStart = start; bestWeight = weight }
    }
    if (bestStart === undefined) return undefined
  }
  const start = Math.max(0, Math.min(bestStart, hay.length - 1))
  return { start, end: Math.min(hay.length, start + needleLines.length), whitespaceOnly: false }
}

/** What differs between the file line and the expected line, in a form a model can act on. */
function describeLineDifference(actual: string, expected: string, subject: string): string {
  const leading = (text: string): string => /^[ \t]*/.exec(text)![0]
  const trailing = (text: string): string => /[ \t]*$/.exec(text)![0]
  let hint = ''
  if (squash(actual) === squash(expected)) {
    const a = leading(actual)
    const e = leading(expected)
    if (a !== e) {
      if (a.includes('\t') && !e.includes('\t')) hint = ` The file indents with tabs here, but ${subject} uses spaces.`
      else if (!a.includes('\t') && e.includes('\t')) hint = ` The file indents with spaces here, but ${subject} uses tabs.`
      else hint = ' The indentation differs.'
    } else if (trailing(actual) !== trailing(expected)) {
      hint = trailing(actual) ? ' The file line has trailing whitespace.' : ` ${subject} has trailing whitespace the file line lacks.`
    } else hint = ' Whitespace inside the line differs.'
  }
  return `the file has ${visible(actual)} but ${subject} has ${visible(expected)}.${hint}`
}

export interface ClosestRegionReport {
  /** 0-based first line of the region in the file. */
  start: number
  /** Report lines: a summary, the file's own numbered lines, and the first difference. */
  lines: string[]
}

/**
 * Where `needleNormalized` (LF-normalized) most plausibly was meant to match in `normalized`,
 * or undefined when nothing in the file resembles it. `subject` names the needle in messages.
 */
export function reportClosestRegion(normalized: string, needleNormalized: string, subject = 'old_string'): ClosestRegionReport | undefined {
  const needle = needleNormalized.split('\n')
  // A trailing newline leaves an empty last element that carries nothing to locate.
  while (needle.length > 1 && needle[needle.length - 1]!.trim() === '') needle.pop()
  const hay = normalized.split('\n')
  const region = findClosestRegion(hay, normalized, needle, needleNormalized)
  if (!region) return undefined
  const windowLines = hay.slice(region.start, region.end)
  // Same line count: compare line by line to point at the first difference.
  let difference = ''
  let focus = region.start
  if (windowLines.length === needle.length) {
    const first = windowLines.findIndex((line, index) => line !== needle[index])
    if (first >= 0) {
      focus = region.start + first
      difference = `First difference at line ${focus + 1}: ${describeLineDifference(windowLines[first]!, needle[first]!, subject)}`
    }
  } else if (region.whitespaceOnly) {
    difference = `${subject} has ${needle.length} line${needle.length === 1 ? '' : 's'} but the file has ${windowLines.length} here: the line breaks differ.`
  }
  const matched = windowLines.filter((line, index) => index < needle.length && squash(line) === squash(needle[index]!)).length
  const span = windowLines.length === 1 ? `line ${region.start + 1}` : `lines ${region.start + 1}-${region.end}`
  const summary = region.whitespaceOnly
    ? `The same text appears at ${span} but differs in whitespace or line breaks`
    : matched > 0
      ? `Closest match: ${span} (${matched} of ${needle.length} line${needle.length === 1 ? '' : 's'} identical ignoring whitespace)`
      : `Closest match: ${span} (similar, but not identical)`
  // Keep long regions short, centered on the first difference.
  const first = Math.max(region.start, Math.min(focus - 3, region.end - REGION_LINES))
  const last = Math.min(region.end, first + REGION_LINES)
  const shown = hay.slice(first, last).map((line, index) => `${first + index + 1}: ${clipLine(line)}`)
  const trimmed = last < region.end ? [`... ${region.end - last} more line${region.end - last === 1 ? '' : 's'} in this region`] : []
  return { start: region.start, lines: [`${summary}:`, ...shown, ...trimmed, ...(difference ? [difference] : [])] }
}

function describeNoMatch(normalized: string, oldNormalized: string, label: string): string {
  const head = `old_string not found in ${label}: it must match the file exactly, including whitespace and indentation.`
  const report = reportClosestRegion(normalized, oldNormalized)
  if (!report) {
    return `${head} No similar text was found in the file. Re-read it with read_file and copy the lines you want to change exactly.`
  }
  return [head, ...report.lines, 'Copy the file text exactly (without the "N: " prefixes) into old_string, or re-read the file with read_file.'].join('\n')
}
