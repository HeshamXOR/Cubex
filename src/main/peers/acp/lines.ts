/**
 * Lines of JSON on a program's standard output, which is how the Agent Client Protocol and Claude Code's stream-json mode both
 * carry their messages. Nothing a program prints is trusted: a line is parsed as unknown data, one that is not a message is
 * ignored, and one that never ends is dropped when it passes the cap.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One line may be a long tool result; anything past this is not a message anyone will read. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024

/** Splits what a program wrote into its lines, dropping a line that runs past the cap. */
export class LineSplitter {
  private buffer = ''
  private discarding = false
  /** Lines that were dropped for their length. */
  dropped = 0

  constructor(private readonly onLine: (line: string) => void, private readonly maxChars = MAX_LINE_CHARS) {}

  push(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (this.discarding) this.discarding = false
      else this.onLine(line)
    }
    if (this.buffer.length > this.maxChars) {
      this.buffer = ''
      this.discarding = true
      this.dropped++
    }
  }

  /** The program ended: whatever is left without a line ending is a last line. */
  end(): void {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() && !this.discarding) this.onLine(rest)
  }
}

/** A line as a message, or undefined when it is not one. */
export function parseMessage(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
