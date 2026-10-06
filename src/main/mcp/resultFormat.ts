/**
 * Turns an MCP tools/call result into the bounded plain text a model receives.
 * Handles every content block type, the isError flag and structuredContent, and
 * never lets a tool push unbounded text into the context: output is capped and
 * the cap is announced so the model knows the result is incomplete.
 */

export const MAX_RESULT_CHARS = 40_000

export interface FormattedResult {
  text: string
  isError: boolean
  /** True when the output was cut at the cap. */
  truncated: boolean
}

export interface FormatOptions {
  maxChars?: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: number): string => value.toLocaleString('en-US')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')} KB`
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

/** Decoded size of a base64 string without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value) } catch { return '[unserializable value]' }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]))
}

function describeResource(resource: unknown): string {
  if (!isRecord(resource)) return '[resource omitted: no details]'
  const uri = str(resource.uri) || 'unknown uri'
  const mime = str(resource.mimeType)
  if (typeof resource.text === 'string') return `Resource ${uri}${mime ? ` (${mime})` : ''}:\n${resource.text}`
  const size = typeof resource.blob === 'string' ? `, ${formatBytes(base64Bytes(resource.blob))}` : ''
  return `[resource omitted: ${uri} (${mime || 'binary'}${size})]`
}

function describeBlock(block: unknown): string {
  if (!isRecord(block)) return '[unsupported content]'
  switch (block.type) {
    case 'text':
      return str(block.text)
    case 'image':
    case 'audio': {
      const size = typeof block.data === 'string' ? `, ${formatBytes(base64Bytes(block.data))}` : ''
      return `[${block.type} omitted: ${str(block.mimeType) || 'unknown type'}${size}]`
    }
    case 'resource':
      return describeResource(block.resource)
    case 'resource_link': {
      const name = str(block.title) || str(block.name)
      const mime = str(block.mimeType)
      const description = str(block.description)
      return `Resource link${name ? ` "${name}"` : ''}: ${str(block.uri)}${mime ? ` (${mime})` : ''}${description ? `. ${description}` : ''}`
    }
    default:
      return `[unsupported content type: ${str(block.type) || 'unknown'}]`
  }
}

/** Accumulates parts up to a character budget and counts what did not fit. */
class CappedText {
  private readonly parts: string[] = []
  private used = 0
  omitted = 0
  capped = false

  constructor(private readonly max: number) {}

  add(part: string): void {
    if (this.capped) {
      this.omitted += part.length
      return
    }
    const separator = this.parts.length > 0 ? 1 : 0
    const room = this.max - this.used - separator
    if (part.length <= room) {
      this.parts.push(part)
      this.used += part.length + separator
      return
    }
    let cut = Math.max(0, room)
    // Never end on half of a surrogate pair.
    if (cut > 0 && (part.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut--
    if (cut > 0) {
      this.parts.push(part.slice(0, cut))
      this.used += cut + separator
    }
    this.omitted += part.length - cut
    this.capped = true
  }

  get empty(): boolean {
    return this.parts.length === 0
  }

  toString(): string {
    const text = this.parts.join('\n')
    return this.capped ? `${text}\n[Result capped at ${number(this.max)} characters; ${number(this.omitted)} more characters were omitted.]` : text
  }
}

export function formatCallToolResult(result: unknown, options: FormatOptions = {}): FormattedResult {
  const max = Math.max(1, Math.floor(options.maxChars ?? MAX_RESULT_CHARS))
  const record = isRecord(result) ? result : {}
  const isError = record.isError === true
  const out = new CappedText(max)

  const blocks = Array.isArray(record.content) ? record.content : []
  for (const block of blocks) out.add(describeBlock(block))

  const structured = record.structuredContent
  if (isRecord(structured) || Array.isArray(structured)) {
    // Servers are told to mirror structured content as JSON text; do not show it twice.
    const mirrored = blocks.some((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return false
      try { return jsonEqual(JSON.parse(block.text), structured) } catch { return false }
    })
    if (!mirrored) out.add(`Structured content: ${safeStringify(structured)}`)
  } else if (!Array.isArray(record.content) && record.toolResult !== undefined) {
    out.add(typeof record.toolResult === 'string' ? record.toolResult : safeStringify(record.toolResult))
  }

  if (out.empty && !out.capped) {
    return { text: isError ? 'The tool reported an error without details.' : '(no content)', isError, truncated: false }
  }
  return { text: out.toString(), isError, truncated: out.capped }
}
