/**
 * Minimal, dependency-free Server-Sent Events parser over a web ReadableStream
 * (which `fetch().body` provides in Node 18+ and the browser). Adapters that
 * don't use an official SDK use this to consume streaming HTTP responses.
 */

import type { ActivityKind } from '../types/request'

export interface SSEMessage {
  event?: string
  data: string
  id?: string
}

export interface SSEOptions {
  signal?: AbortSignal
  /**
   * Called for every chunk of bytes that arrives, including keep-alive comments (`: keep-alive`) that never become
   * a message. A server that is queueing or thinking quietly often sends only those, and they prove it is alive.
   */
  onActivity?: (kind: ActivityKind) => void
}

const DECODER_LABEL = 'utf-8'

export async function* parseSSE(
  body: ReadableStream<Uint8Array> | null,
  options: SSEOptions = {}
): AsyncGenerator<SSEMessage> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder(DECODER_LABEL)
  let buffer = ''

  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      if (options.signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      options.onActivity?.('data')
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      // SSE events are separated by a blank line ("\n\n" or "\r\n\r\n").
      while ((sep = indexOfDoubleNewline(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^(\r\n|\n){2}/, '')
        const parsed = parseEventBlock(rawEvent)
        if (parsed) yield parsed
      }
    }
    // Flush any trailing event without a terminating blank line.
    const tail = buffer.trim()
    if (tail) {
      const parsed = parseEventBlock(tail)
      if (parsed) yield parsed
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf('\n\n')
  const b = s.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

function parseEventBlock(block: string): SSEMessage | null {
  const lines = block.split(/\r\n|\n/)
  let event: string | undefined
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue // comment / keepalive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        event = value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'id':
        id = value
        break
      default:
        break
    }
  }
  if (dataLines.length === 0 && event === undefined) return null
  return { ...(event ? { event } : {}), ...(id ? { id } : {}), data: dataLines.join('\n') }
}

/** Parse SSE and JSON.parse each `data` payload, skipping `[DONE]` sentinels. */
export async function* parseSSEJson<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
  options: SSEOptions = {}
): AsyncGenerator<{ event?: string; data: T }> {
  for await (const msg of parseSSE(body, options)) {
    if (msg.data === '[DONE]') return
    try {
      yield { ...(msg.event ? { event: msg.event } : {}), data: JSON.parse(msg.data) as T }
    } catch {
      // ignore non-JSON keepalive frames
    }
  }
}
