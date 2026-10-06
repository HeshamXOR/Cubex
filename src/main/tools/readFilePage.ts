import { createReadStream } from 'node:fs'

const MAX_LINE_CHARACTERS = 4_096
const MAX_SCAN_BYTES = 32 * 1024 * 1024

export interface FilePage {
  lines: Array<{ number: number; text: string; truncated: boolean }>
  hasMore: boolean
  scanLimitReached: boolean
  fullFile: boolean
  lastScannedLine: number
}

/** Stream just the requested window. Memory remains bounded even for a huge single line. */
export async function readFilePage(
  path: string,
  offset: number,
  limit: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<FilePage> {
  signal?.throwIfAborted()
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024, signal })
  const lines: FilePage['lines'] = []
  let lineNumber = 1
  let pending = ''
  let lineCharacters = 0
  let lastCharacter = ''
  let scannedBytes = 0
  let outputBytes = 0
  let hasMore = false
  let scanLimitReached = false
  let lineWasTruncated = false

  const finishLine = (): boolean => {
    if (lineNumber >= offset) {
      const characters = lineCharacters - Number(lastCharacter === '\r')
      const text = pending.slice(0, Math.min(characters, MAX_LINE_CHARACTERS))
      const truncated = characters > MAX_LINE_CHARACTERS
      // Allow space for a line number, newline, and any per-line truncation marker.
      const bytes = Buffer.byteLength(text, 'utf8') + 80
      if (outputBytes + bytes > maxBytes) {
        hasMore = true
        return false
      }
      lines.push({ number: lineNumber, text, truncated })
      outputBytes += bytes
      lineWasTruncated ||= truncated
    }
    lineNumber++
    pending = ''
    lineCharacters = 0
    lastCharacter = ''
    return true
  }

  try {
    chunks: for await (const value of stream) {
      signal?.throwIfAborted()
      const chunk = String(value)
      scannedBytes += Buffer.byteLength(chunk, 'utf8')
      if (scannedBytes > MAX_SCAN_BYTES) {
        hasMore = true
        scanLimitReached = true
        break
      }
      let start = 0
      while (start < chunk.length) {
        if (lines.length === limit) {
          hasMore = true
          break chunks
        }
        const newline = chunk.indexOf('\n', start)
        const end = newline < 0 ? chunk.length : newline
        const length = end - start
        if (length > 0) {
          if (lineNumber >= offset && pending.length < MAX_LINE_CHARACTERS) {
            pending += chunk.slice(start, Math.min(end, start + MAX_LINE_CHARACTERS - pending.length))
          }
          lineCharacters += length
          lastCharacter = chunk[end - 1]!
        }
        if (newline < 0) break
        if (!finishLine()) break chunks
        start = newline + 1
      }
    }
    signal?.throwIfAborted()
    if (!hasMore && lineCharacters > 0) finishLine()
  } finally {
    stream.destroy()
  }

  return {
    lines,
    hasMore,
    scanLimitReached,
    fullFile: offset === 1 && !hasMore && !lineWasTruncated,
    lastScannedLine: lineNumber - 1
  }
}
