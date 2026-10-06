import { describe, it, expect } from 'vitest'
import { SseParser, SseError } from './sse'

const feedAll = (text: string): ReturnType<SseParser['push']> => new SseParser().push(text)

describe('SseParser', () => {
  it('parses a single message event', () => {
    expect(feedAll('data: {"a":1}\n\n')).toEqual([{ event: 'message', data: '{"a":1}' }])
  })

  it('joins multi-line data with newlines', () => {
    expect(feedAll('data: line one\ndata: line two\ndata:\ndata: line four\n\n')).toEqual([
      { event: 'message', data: 'line one\nline two\n\nline four' }
    ])
  })

  it('keeps the event type and the event id', () => {
    const [event] = feedAll('event: endpoint\nid: 42\ndata: /messages?s=1\n\n')
    expect(event).toEqual({ event: 'endpoint', data: '/messages?s=1', id: '42' })
  })

  it('carries the last event id into later events and exposes it on the parser', () => {
    const parser = new SseParser()
    const events = parser.push('id: a1\ndata: one\n\ndata: two\n\nid: a3\ndata: three\n\n')
    expect(events.map((e) => e.id)).toEqual(['a1', 'a1', 'a3'])
    expect(parser.lastEventId).toBe('a3')
  })

  it('records the id of a priming event (empty data) and dispatches it with empty data', () => {
    const parser = new SseParser()
    expect(parser.push('id: prime-7\ndata:\n\n')).toEqual([{ event: 'message', data: '', id: 'prime-7' }])
    expect(parser.lastEventId).toBe('prime-7')
    expect(parser.push('data: x\n\n')[0]).toEqual({ event: 'message', data: 'x', id: 'prime-7' })
  })

  it('dispatches nothing for an id-only block but still records the id', () => {
    const parser = new SseParser()
    expect(parser.push('id: only\n\n')).toEqual([])
    expect(parser.lastEventId).toBe('only')
  })

  it('ignores an id that contains NUL', () => {
    const parser = new SseParser()
    parser.push('id: bad\u0000id\ndata: x\n\n')
    expect(parser.lastEventId).toBeUndefined()
  })

  it('ignores comments and keep-alives', () => {
    expect(feedAll(':\n: keep-alive\ndata: ok\n\n:\n\n')).toEqual([{ event: 'message', data: 'ok' }])
  })

  it('handles CRLF, lone CR and LF endings', () => {
    expect(feedAll('data: a\r\n\r\ndata: b\r\rdata: c\n\n').map((e) => e.data)).toEqual(['a', 'b', 'c'])
  })

  it('handles a CRLF pair split across chunks', () => {
    const parser = new SseParser()
    const first = parser.push('data: a\r')
    const second = parser.push('\n\r')
    const third = parser.push('\n')
    expect([...first, ...second, ...third].map((e) => e.data)).toEqual(['a'])
  })

  it('strips only one leading space and keeps colons inside values', () => {
    expect(feedAll('data:  two spaces: and a colon\n\n')[0]!.data).toBe(' two spaces: and a colon')
    expect(feedAll('data:nospace\n\n')[0]!.data).toBe('nospace')
  })

  it('treats a field without a colon as an empty value', () => {
    expect(feedAll('data\ndata: x\n\n')[0]!.data).toBe('\nx')
  })

  it('records the retry field only when it is all digits', () => {
    const parser = new SseParser()
    parser.push('retry: 1500\n\n')
    expect(parser.retryMs).toBe(1500)
    parser.push('retry: soon\n\n')
    expect(parser.retryMs).toBe(1500)
  })

  it('produces identical events when fed one character at a time', () => {
    const text = 'id: 1\nevent: message\ndata: {"x":\ndata: 2}\n\r\n: c\r\ndata: tail\n\n'
    const whole = new SseParser().push(text)
    const parser = new SseParser()
    const split: typeof whole = []
    for (const ch of text) split.push(...parser.push(ch))
    expect(split).toEqual(whole)
    expect(whole).toHaveLength(2)
  })

  it('strips a leading byte order mark', () => {
    expect(feedAll('\uFEFFdata: hi\n\n')).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('discards an incomplete trailing event at the end of the stream', () => {
    const parser = new SseParser()
    expect(parser.push('data: done\n\ndata: partial')).toHaveLength(1)
    expect(parser.end()).toBeUndefined()
  })

  it('rejects an event larger than the cap', () => {
    const parser = new SseParser({ maxEventChars: 64 })
    expect(() => parser.push(`data: ${'x'.repeat(200)}\n\n`)).toThrow(SseError)
  })

  it('rejects a single line longer than the cap before it ends', () => {
    const parser = new SseParser({ maxEventChars: 64 })
    expect(() => parser.push('data: ' + 'x'.repeat(200))).toThrow(SseError)
  })
})
