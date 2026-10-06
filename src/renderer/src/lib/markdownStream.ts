/**
 * Helpers that let a markdown answer render cleanly while it is still arriving.
 *
 * A raw prefix of markdown renders badly: half a table shows its pipes, an open
 * fence turns code into prose until it closes, `**bold` flips styles mid-word.
 * `repairMarkdown` makes any prefix render the way its finished form will, and
 * `splitMarkdownBlocks` lets completed blocks stay rendered while only the
 * block being written changes.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const TABLE_ROW = /^ {0,3}\|/
const TABLE_DELIMITER = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/
/** Lines that always begin a new inline context: list items and headings. */
const BLOCK_START = /^ {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$))/
/** What may follow an emphasis opener. Emphasis wraps words, so "*.ts" is not one. */
const OPENS_ONTO = /[\p{L}\p{N}[(]/u

interface Fence { char: string; length: number }

function openingFence(line: string): Fence | undefined {
  const match = FENCE.exec(line)
  if (!match) return undefined
  const marker = match[1]!
  // A backtick fence's info string cannot contain backticks.
  if (marker[0] === '`' && match[2]!.includes('`')) return undefined
  return { char: marker[0]!, length: marker.length }
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return !!match && match[1]![0] === fence.char && match[1]!.length >= fence.length
}

/** Lines that still change meaning when more characters arrive. */
function isUnstableTail(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return /^#{1,6}$/.test(trimmed) || // a heading marker with no text yet
    /^(?:[-*+]|\d{1,9}[.)]?)$/.test(trimmed) || // a bare list marker, or digits that may become one
    /^(?:-{2,}|=+|_{2,}|\*{2,})$/.test(trimmed) || // a rule or setext underline in progress
    trimmed === '>' ||
    /^`{1,2}$/.test(trimmed) // a fence in progress
}

/** Blank out complete code spans so markers inside them are not counted. */
function maskCode(text: string): string {
  return text.replace(/`[^`]*`/g, (span) => 'x'.repeat(span.length))
}

interface Opener { marker: string; index: number; end: number }

/**
 * Find emphasis delimiters that are still open, following CommonMark's
 * flanking rules closely enough for prose: an opener sits before a word, a
 * closer after one.
 */
function openDelimiters(scan: string): Opener[] {
  const stack: Opener[] = []
  const runs = /\*+|~~|(?<![\p{L}\p{N}])__|__(?![\p{L}\p{N}])/gu
  for (const match of scan.matchAll(runs)) {
    const run = match[0]
    const index = match.index!
    const before = scan[index - 1]
    const after = scan[index + run.length]
    const canClose = before !== undefined && !/\s/.test(before)
    // At the very end the next character has not arrived yet, so it may still open.
    const canOpen = after === undefined || OPENS_ONTO.test(after)
    // Star runs: "*" is emphasis, "**" strong, "***" both. Longer runs are literal.
    const parts = run[0] === '*' ? (run.length === 1 ? ['*'] : run.length === 2 ? ['**'] : run.length === 3 ? ['**', '*'] : []) : [run]
    for (const marker of parts) {
      const open = stack.map((entry) => entry.marker).lastIndexOf(marker)
      if (canClose && open >= 0) stack.splice(open, 1)
      else if (canOpen) stack.push({ marker, index, end: index + run.length })
    }
  }
  return stack
}

/** Close or hide inline syntax that is still open at the end of the paragraph. */
function repairInline(paragraph: string): string {
  let text = paragraph
  // A trailing backslash escapes whatever comes next.
  if (/(?<!\\)\\$/.test(text)) text = text.slice(0, -1).trimEnd()

  // Inline code first: inside it, every other marker is literal.
  const ticks = (text.match(/`+/g) ?? []).filter((run) => run.length === 1).length
  if (ticks % 2 === 1) {
    const tick = text.lastIndexOf('`')
    // A lone backtick with nothing after it would render as a literal "``".
    return text.slice(tick + 1).trim() ? `${text}\`` : text.slice(0, tick).trimEnd()
  }

  // Images appear only once complete; a half-written URL never renders as text.
  const image = maskCode(text).lastIndexOf('![')
  if (image >= 0 && !/^!\[[^\]]*\]\([^)]*\)/.test(maskCode(text).slice(image))) {
    return repairInline(text.slice(0, image).trimEnd())
  }

  // Links show their label while the URL is still arriving. "[" right after
  // a word ("items[0") is not a link.
  const masked = maskCode(text)
  const opens = [...masked.matchAll(/(?<![\p{L}\p{N}_\]!\\])\[/gu)]
  const open = opens.at(-1)?.index
  if (open !== undefined) {
    const rest = masked.slice(open)
    const complete = /^\[[^\]]*\]\([^)]*\)/.test(rest) || (/^\[[^\]]*\](?!\()/.test(rest) && !/^\[[^\]]*\]$/.test(rest))
    if (!complete) {
      const label = /^\[([^\]]*)\]?(?:\([^)]*)?$/.exec(text.slice(open))
      if (label) text = text.slice(0, open) + label[1]
    }
  }

  // Close what is still open, innermost first. An opener with nothing after it
  // yet is dropped instead: "**" alone renders as four literal stars.
  for (let guard = 0; guard < 8; guard++) {
    const stack = openDelimiters(maskCode(text))
    const last = stack.at(-1)
    if (!last) return text
    if (!text.slice(last.end).trim()) {
      text = text.slice(0, last.index).trimEnd()
      continue
    }
    // Closing right after whitespace would leave the markers literal.
    return text.replace(/\s+$/, '') + stack.map((entry) => entry.marker).reverse().join('')
  }
  return text
}

/**
 * Make a markdown prefix render as its finished form will. Unfinished
 * structure is either closed (fences, emphasis, inline code) or held back
 * until it can render correctly (table rows, list and heading markers).
 */
export function repairMarkdown(input: string): string {
  if (!input) return input
  const lines = input.split('\n')
  const terminated = input.endsWith('\n')
  if (terminated) lines.pop()

  let fence: Fence | undefined
  let fenceLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      if (closesFence(line, fence)) fence = undefined
    } else {
      const opened = openingFence(line)
      if (opened) { fence = opened; fenceLine = i }
    }
  }

  if (fence) {
    const body = [...lines]
    const last = body.at(-1) ?? ''
    // A closing fence still being typed would flash as code text.
    if (!terminated && body.length - 1 > fenceLine && new RegExp(`^ {0,3}\\${fence.char}{1,${fence.length}}$`).test(last)) body.pop()
    if (!terminated && body.length - 1 === fenceLine) {
      // The info string is still arriving ("```ty"): wait for the line to finish.
      body.pop()
      return body.join('\n')
    }
    return `${body.join('\n')}\n${fence.char.repeat(fence.length)}`
  }

  // Outside code from here on. The unterminated last line may still change meaning.
  if (!terminated && lines.length && isUnstableTail(lines.at(-1)!)) lines.pop()

  // Tables render once their delimiter row exists; partial rows wait.
  let start = lines.length
  while (start > 0 && TABLE_ROW.test(lines[start - 1]!)) start--
  if (start < lines.length) {
    const rows = lines.slice(start)
    const completeRows = terminated ? rows : rows.slice(0, -1)
    const hasDelimiter = completeRows.length >= 2 && TABLE_DELIMITER.test(completeRows[1]!)
    lines.splice(start, rows.length, ...(hasDelimiter ? completeRows : []))
    return lines.join('\n') + (terminated && hasDelimiter ? '\n' : '')
  }

  if (!lines.length) return ''
  // A paragraph followed by a blank line is finished: it renders as it is.
  if (lines.at(-1)!.trim() === '') return lines.join('\n') + (terminated ? '\n' : '')

  // Inline repair applies to the paragraph being written.
  let paragraphStart = lines.length - 1
  while (paragraphStart > 0) {
    const previous = lines[paragraphStart - 1]!
    if (BLOCK_START.test(lines[paragraphStart]!) || previous.trim() === '' || openingFence(previous) || /^ {0,3}#{1,6}(?:\s|$)/.test(previous)) break
    paragraphStart--
  }
  const paragraph = lines.slice(paragraphStart).join('\n')
  return [...lines.slice(0, paragraphStart), repairInline(paragraph)].join('\n') + (terminated ? '\n' : '')
}

/**
 * Split markdown into top-level blocks (paragraphs, lists, fences, tables...).
 * Joining the blocks reproduces the input exactly. Lists stay whole across
 * blank lines so their numbering and spacing render as one list.
 */
export function splitMarkdownBlocks(input: string): string[] {
  if (!input) return []
  const lines = input.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: Fence | undefined
  let inList = false

  const flush = (): void => {
    if (current.length) blocks.push(current.join('\n'))
    current = []
    inList = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      current.push(line)
      if (closesFence(line, fence)) fence = undefined
      continue
    }
    const opened = openingFence(line)
    if (opened) {
      // An indented fence inside a list item belongs to that item.
      if (!(inList && /^\s{2,}/.test(line))) flush()
      fence = opened
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      current.push(line)
      let next = i + 1
      while (next < lines.length && lines[next]!.trim() === '') next++
      const following = lines[next]
      const listContinues = inList && following !== undefined && (LIST_ITEM.test(following) || /^\s{2,}\S/.test(following))
      if (following !== undefined && !listContinues) {
        // Keep the blank run with the block it ends.
        while (i + 1 < next) current.push(lines[++i]!)
        flush()
      }
      continue
    }
    // Lines inside a block run together, so a list can begin after a paragraph line.
    if (LIST_ITEM.test(line)) inList = true
    current.push(line)
  }
  flush()
  // Each block carries its own trailing newline so the join is exact.
  return blocks.map((block, index) => (index < blocks.length - 1 ? `${block}\n` : block))
}

/** Index just past the last whitespace, so partially received words stay hidden. */
export function wordBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (/\s/.test(text[i]!)) return i + 1
  }
  return 0
}

/**
 * Advance a reveal position by about `budget` characters, then finish the
 * word in progress so no word is ever shown half-drawn. Never passes `limit`.
 */
export function advanceReveal(text: string, shown: number, budget: number, limit = text.length): number {
  const end = Math.min(limit, text.length)
  if (shown >= end) return end
  let next = Math.min(end, shown + Math.max(1, Math.floor(budget)))
  while (next < end && !/\s/.test(text[next]!)) next++
  return next
}
