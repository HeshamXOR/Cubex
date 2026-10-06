/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 * Feed it decoded text in any chunking; it returns the events completed so far.
 * Used by the MCP HTTP transports. No I/O here, so it is trivially testable.
 */

export interface SseEvent {
  /** The `event:` field; `message` when absent. */
  event: string
  /** The `data:` lines joined with newlines (may be empty, e.g. a priming event). */
  data: string
  /** The last event id seen on the stream when this event was dispatched. */
  id?: string
}

export class SseError extends Error {}

export interface SseParserOptions {
  /** Upper bound on one event (data plus a pending line), in characters. */
  maxEventChars?: number
}

const DEFAULT_MAX_EVENT_CHARS = 16 * 1024 * 1024

export class SseParser {
  /** Last `id:` value seen; sent back as Last-Event-ID when resuming. */
  lastEventId: string | undefined
  /** Last valid `retry:` value in milliseconds. */
  retryMs: number | undefined

  private partial = ''
  private skipLineFeed = false
  private atStart = true
  private eventType = ''
  private dataBuffer = ''
  private hasData = false
  private readonly maxChars: number

  constructor(options: SseParserOptions = {}) {
    this.maxChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS
  }

  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = []
    let text = chunk
    if (text.length > 0 && this.atStart) {
      this.atStart = false
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    let start = 0
    if (this.skipLineFeed && text.length > 0) {
      this.skipLineFeed = false
      if (text.charCodeAt(0) === 10) start = 1
    }
    for (let i = start; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code !== 10 && code !== 13) continue
      const line = this.partial + text.slice(start, i)
      this.partial = ''
      if (code === 13) {
        // A CR may be the first half of CRLF; the LF can arrive in the next chunk.
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 10) i++
        } else this.skipLineFeed = true
      }
      start = i + 1
      this.processLine(line, events)
    }
    this.partial += text.slice(start)
    if (this.partial.length + this.dataBuffer.length > this.maxChars) throw new SseError('SSE event exceeds the size limit.')
    return events
  }

  /** The stream ended: per the spec an incomplete trailing event is discarded. */
  end(): void {
    this.partial = ''
    this.eventType = ''
    this.dataBuffer = ''
    this.hasData = false
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') return this.dispatch(events)
    if (line.charCodeAt(0) === 58) return // comment or keep-alive
    const colon = line.indexOf(':')
    let field = line
    let value = ''
    if (colon !== -1) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.charCodeAt(0) === 32) value = value.slice(1)
    }
    switch (field) {
      case 'event':
        this.eventType = value
        break
      case 'data':
        this.dataBuffer += `${value}\n`
        this.hasData = true
        if (this.dataBuffer.length > this.maxChars) throw new SseError('SSE event exceeds the size limit.')
        break
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value)
        break
      default:
        break
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (!this.hasData) {
      this.eventType = ''
      return
    }
    const data = this.dataBuffer.endsWith('\n') ? this.dataBuffer.slice(0, -1) : this.dataBuffer
    events.push({
      event: this.eventType || 'message',
      data,
      ...(this.lastEventId !== undefined ? { id: this.lastEventId } : {})
    })
    this.eventType = ''
    this.dataBuffer = ''
    this.hasData = false
  }
}
