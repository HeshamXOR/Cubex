/**
 * Parser for the "*** Begin Patch" envelope GPT-style models are trained on:
 *
 *   *** Begin Patch
 *   *** Add File: path          (every following line starts with "+")
 *   *** Update File: path       (optional "*** Move to: path", then @@ hunks)
 *   *** Delete File: path
 *   *** End Patch
 *
 * Pure and tolerant of the small format drifts models produce (code fences, a
 * heredoc wrapper, CRLF, unified-diff `@@ -1,3 +1,4 @@` ranges, blank context lines
 * without their leading space) but strict about truncation: a patch without its end
 * marker is rejected whole, so a cut-off hunk is never half applied.
 */

export interface PatchHunkLine {
  kind: 'context' | 'remove' | 'add'
  text: string
}

export interface PatchChunk {
  /** `@@ text` lines, applied in order to place the chunk after those lines. */
  anchors: string[]
  lines: PatchHunkLine[]
  /** `*** End of File` follows the chunk: it must match at the end of the file. */
  endOfFile: boolean
  /** 1-based line in the patch text where the chunk starts, for messages. */
  line: number
}

export type PatchOperation =
  | { kind: 'add'; path: string; lines: string[]; line: number }
  | { kind: 'delete'; path: string; line: number }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[]; line: number }

export type ParsedPatch = { ok: true; operations: PatchOperation[] } | { ok: false; error: string }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const END_OF_FILE = '*** End of File'
const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File:\s*(.*)$/
const MOVE_HEADER = /^\*\*\* Move to:\s*(.*)$/
/** `@@ -12,5 +12,6 @@ optional text`: a unified-diff range, not a context anchor. */
const UNIFIED_RANGE = /^-\d+(?:,\d+)? \+\d+(?:,\d+)? @@\s*(.*)$/

const MAX_PATH_CHARACTERS = 1_024

/** Lines models wrap around the envelope: blank lines, code fences and heredoc markers. */
function isEnvelopeNoise(line: string): boolean {
  const text = line.trim()
  return text === '' || text.startsWith('```') || /<<-?\s*['"]?\w+['"]?/.test(text) || /^['"]?(EOF|PATCH)['"]?$/.test(text)
}

function cleanPath(raw: string): string {
  const text = raw.trim()
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).trim() : text
}

function clip(line: string): string {
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

const fail = (error: string): ParsedPatch => ({ ok: false, error })

export function parsePatch(patch: string): ParsedPatch {
  if (typeof patch !== 'string') return fail('The patch must be a string.')
  const raw = patch.replace(/\r\n/g, '\n').split('\n')
  let first = 0
  let last = raw.length - 1
  while (first <= last && isEnvelopeNoise(raw[first]!)) first++
  while (last >= first && isEnvelopeNoise(raw[last]!)) last--
  if (first > last || raw[first]!.trim() !== BEGIN) return fail(`The patch must start with "${BEGIN}".`)
  if (last === first || raw[last]!.trim() !== END) {
    return fail(`The patch must end with "${END}". It may have been cut off, so nothing was applied.`)
  }

  const operations: PatchOperation[] = []
  let i = first + 1
  while (i < last) {
    const line = raw[i]!
    if (line.trim() === '') { i++; continue }
    const header = FILE_HEADER.exec(line)
    if (!header) {
      return fail(`Unexpected line ${i + 1} in the patch: expected "*** Add File:", "*** Update File:" or "*** Delete File:" but found "${clip(line)}".`)
    }
    const kind = header[1]!
    const path = cleanPath(header[2]!)
    if (!path || path.length > MAX_PATH_CHARACTERS || path.includes('\0')) return fail(`${kind} File at line ${i + 1} needs a valid path.`)
    const headerLine = i + 1
    i++
    // The hunk body runs until the next header or the end marker.
    let end = i
    while (end < last && !FILE_HEADER.test(raw[end]!)) end++

    if (kind === 'Delete') {
      for (let at = i; at < end; at++) {
        if (raw[at]!.trim() !== '') return fail(`Unexpected line ${at + 1} in the patch: a Delete File hunk has no body but found "${clip(raw[at]!)}".`)
      }
      operations.push({ kind: 'delete', path, line: headerLine })
      i = end
      continue
    }

    if (kind === 'Add') {
      let stop = end
      while (stop > i && raw[stop - 1]!.trim() === '') stop--
      const lines: string[] = []
      for (let at = i; at < stop; at++) {
        const text = raw[at]!
        if (!text.startsWith('+')) return fail(`Add File ${path}: line ${at + 1} must start with "+" but found "${clip(text)}".`)
        lines.push(text.slice(1))
      }
      operations.push({ kind: 'add', path, lines, line: headerLine })
      i = end
      continue
    }

    // Update File: optional move, then hunks.
    let moveTo: string | undefined
    while (i < end && raw[i]!.trim() === '') i++
    const move = i < end ? MOVE_HEADER.exec(raw[i]!) : null
    if (move) {
      moveTo = cleanPath(move[1]!)
      if (!moveTo || moveTo.length > MAX_PATH_CHARACTERS || moveTo.includes('\0')) return fail(`Move to at line ${i + 1} needs a valid path.`)
      i++
    }
    let stop = end
    while (stop > i && raw[stop - 1]!.trim() === '') stop--
    const chunks: PatchChunk[] = []
    let chunk: PatchChunk | undefined
    for (let at = i; at < stop; at++) {
      const text = raw[at]!
      if (text.startsWith('@@')) {
        let anchor = text.slice(2).trim()
        const range = UNIFIED_RANGE.exec(anchor)
        if (range) anchor = range[1]!.trim()
        anchor = anchor.replace(/\s+@@$/, '').trim()
        // A new @@ after hunk lines starts a new hunk; consecutive @@ lines stack as nested anchors.
        if (!chunk || chunk.lines.length > 0) {
          chunk = { anchors: [], lines: [], endOfFile: false, line: at + 1 }
          chunks.push(chunk)
        }
        if (anchor) chunk.anchors.push(anchor)
        continue
      }
      if (text.trim() === END_OF_FILE) {
        if (!chunk || chunk.lines.length === 0) return fail(`Unexpected "${END_OF_FILE}" at line ${at + 1}: it must follow the lines of a hunk.`)
        chunk.endOfFile = true
        chunk = undefined
        continue
      }
      let hunkLine: PatchHunkLine
      if (text === '') hunkLine = { kind: 'context', text: '' }
      else if (text[0] === ' ') hunkLine = { kind: 'context', text: text.slice(1) }
      else if (text[0] === '+') hunkLine = { kind: 'add', text: text.slice(1) }
      else if (text[0] === '-') hunkLine = { kind: 'remove', text: text.slice(1) }
      else return fail(`Unexpected line ${at + 1} in the patch: hunk lines must start with " ", "+" or "-" but found "${clip(text)}".`)
      if (!chunk) {
        chunk = { anchors: [], lines: [], endOfFile: false, line: at + 1 }
        chunks.push(chunk)
      }
      chunk.lines.push(hunkLine)
    }
    const empty = chunks.find((item) => item.lines.length === 0)
    if (empty) return fail(`Update File ${path}: the "@@" hunk at line ${empty.line} has no lines.`)
    if (chunks.length === 0 && !moveTo) return fail(`Update File ${path} has no changes: add @@ hunks or a "*** Move to:" line.`)
    operations.push({ kind: 'update', path, ...(moveTo ? { moveTo } : {}), chunks, line: headerLine })
    i = end
  }
  if (operations.length === 0) return fail('The patch is empty: it contains no changes.')
  return { ok: true, operations }
}

/**
 * Every path a patch names (files and move targets) without validating the rest, so
 * permission gating can inspect a patch the full parser would reject. Never throws.
 */
export function patchTargetPaths(patch: string): string[] {
  if (typeof patch !== 'string') return []
  const paths: string[] = []
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    const match = FILE_HEADER.exec(line) ?? MOVE_HEADER.exec(line)
    const path = match ? cleanPath(match[match.length - 1]!) : ''
    if (path) paths.push(path)
  }
  return paths
}
