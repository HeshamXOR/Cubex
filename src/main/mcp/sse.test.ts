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

  it('carries the last event id into later events and exposes it on the parser', () => {
    const parser = new SseParser()
    const events = parser.push('id: a1\ndata: one\n\ndata: two\n\nid: a3\ndata: three\n\n')
    expect(events.map((e) => e.id)).toEqual(['a1', 'a1', 'a3'])
    expect(parser.lastEventId).toBe('a3')
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

  it('produces identical events when fed one character at a time', () => {
    const text = 'id: 1\nevent: message\ndata: {"x":\ndata: 2}\n\r\n: c\r\ndata: tail\n\n'
    const whole = new SseParser().push(text)
    const parser = new SseParser()
    const split: typeof whole = []
    for (const ch of text) split.push(...parser.push(ch))
    expect(split).toEqual(whole)
    expect(whole).toHaveLength(2)
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
