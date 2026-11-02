import { describe, it, expect } from 'vitest'
import { formatCallToolResult } from './resultFormat'

describe('formatCallToolResult', () => {
  it('joins text blocks with newlines', () => {
    const r = formatCallToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    expect(r).toEqual({ text: 'one\ntwo', isError: false, truncated: false })
  })

  it('keeps the isError flag and never returns empty error text', () => {
    expect(formatCallToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toMatchObject({ text: 'boom', isError: true })
    const empty = formatCallToolResult({ isError: true, content: [] })
    expect(empty.isError).toBe(true)
    expect(empty.text).toMatch(/error/i)
  })

  it('replaces image data with a placeholder naming the type and size', () => {
    const data = 'A'.repeat(4000)
    const r = formatCallToolResult({ content: [{ type: 'image', data, mimeType: 'image/png' }] })
    expect(r.text).toContain('image/png')
    expect(r.text).toMatch(/\[image omitted/)
    expect(r.text).not.toContain(data)
    expect(r.text).toMatch(/2\.\d KB|3 KB|2 KB/)
  })

  it('shows the text of an embedded resource with its uri and hides blobs', () => {
    const r = formatCallToolResult({
      content: [
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', mimeType: 'application/octet-stream', blob: 'QUJDREVGRw==' } }
      ]
    })
    expect(r.text).toContain('file:///a.txt')
    expect(r.text).toContain('hello')
    expect(r.text).toContain('file:///b.bin')
    expect(r.text).not.toContain('QUJDREVGRw==')
  })

  it('appends structured content that the text blocks do not already carry', () => {
    const r = formatCallToolResult({ content: [{ type: 'text', text: 'done' }], structuredContent: { count: 3 } })
    expect(r.text).toBe('done\nStructured content: {"count":3}')
  })

  it('caps long output and says so', () => {
    const big = 'x'.repeat(100_000)
    const r = formatCallToolResult({ content: [{ type: 'text', text: big }] }, { maxChars: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThan(1300)
    expect(r.text.startsWith('x'.repeat(1000))).toBe(true)
    expect(r.text).toMatch(/capped at 1,000 characters/)
    expect(r.text).toMatch(/99,000 more characters/)
  })

  it('does not split a surrogate pair at the cut', () => {
    const text = '\u{1F600}'.repeat(50)
    const r = formatCallToolResult({ content: [{ type: 'text', text }] }, { maxChars: 11 })
    const kept = r.text.split('\n[')[0]!
    expect(kept.length % 2).toBe(0)
    expect(kept).toBe('\u{1F600}'.repeat(kept.length / 2))
  })
})
