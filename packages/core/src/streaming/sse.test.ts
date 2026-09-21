import { describe, expect, it } from 'vitest'
import { parseSSE, parseSSEJson } from './sse'

function streamFromString(s: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    }
  })
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('parseSSE', () => {
  it('parses events split across arbitrary byte boundaries', async () => {
    const sse = 'event: message\ndata: hello\n\ndata: world\n\n'
    const events = await collect(parseSSE(streamFromString(sse, 3)))
    expect(events).toEqual([
      { event: 'message', data: 'hello' },
      { data: 'world' }
    ])
  })

  it('joins multi-line data and ignores comments/keepalives', async () => {
    const sse = ': keepalive\ndata: line1\ndata: line2\n\n'
    const events = await collect(parseSSE(streamFromString(sse)))
    expect(events).toEqual([{ data: 'line1\nline2' }])
  })
})

describe('parseSSEJson', () => {
  it('parses JSON payloads and stops at [DONE]', async () => {
    const sse = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\ndata: {"a":3}\n\n'
    const events = await collect(parseSSEJson<{ a: number }>(streamFromString(sse, 5)))
    expect(events.map((e) => e.data.a)).toEqual([1, 2])
  })

  it('skips non-JSON frames without throwing', async () => {
    const sse = 'data: not json\n\ndata: {"ok":true}\n\n'
    const events = await collect(parseSSEJson<{ ok: boolean }>(streamFromString(sse)))
    expect(events).toHaveLength(1)
    expect(events[0]!.data.ok).toBe(true)
  })
})
