import { describe, it, expect } from 'vitest'
import { formatCallToolResult, MAX_RESULT_CHARS } from './resultFormat'

describe('formatCallToolResult', () => {
  it('joins text blocks with newlines', () => {
    const r = formatCallToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    expect(r).toEqual({ text: 'one\ntwo', isError: false, truncated: false })
  })

  it('reports an empty result', () => {
    expect(formatCallToolResult({ content: [] }).text).toBe('(no content)')
    expect(formatCallToolResult(undefined).text).toBe('(no content)')
    expect(formatCallToolResult(null).isError).toBe(false)
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

  it('replaces audio data with a placeholder', () => {
    const r = formatCallToolResult({ content: [{ type: 'audio', data: 'QUJD', mimeType: 'audio/wav' }] })
    expect(r.text).toMatch(/\[audio omitted: audio\/wav/)
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

  it('describes a resource link', () => {
    const r = formatCallToolResult({
      content: [{ type: 'resource_link', uri: 'file:///proj/readme.md', name: 'readme', mimeType: 'text/markdown', description: 'Project readme' }]
    })
    expect(r.text).toContain('readme')
    expect(r.text).toContain('file:///proj/readme.md')
    expect(r.text).toContain('Project readme')
  })

  it('names unsupported block types instead of dropping them silently', () => {
    expect(formatCallToolResult({ content: [{ type: 'hologram' }] }).text).toContain('hologram')
  })

  it('appends structured content that the text blocks do not already carry', () => {
    const r = formatCallToolResult({ content: [{ type: 'text', text: 'done' }], structuredContent: { count: 3 } })
    expect(r.text).toBe('done\nStructured content: {"count":3}')
  })

  it('does not duplicate structured content that a text block already serializes', () => {
    const r = formatCallToolResult({
      content: [{ type: 'text', text: '{ "count": 3 }' }],
      structuredContent: { count: 3 }
    })
    expect(r.text).toBe('{ "count": 3 }')
  })

  it('uses structured content alone when there are no content blocks', () => {
    expect(formatCallToolResult({ structuredContent: { ok: true } }).text).toBe('Structured content: {"ok":true}')
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

  it('caps across many blocks without building the whole text', () => {
    const content = Array.from({ length: 5000 }, (_, i) => ({ type: 'text', text: `line ${i}` }))
    const r = formatCallToolResult({ content }, { maxChars: 500 })
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThan(800)
    expect(r.text).toMatch(/capped/)
  })

  it('does not split a surrogate pair at the cut', () => {
    const text = '\u{1F600}'.repeat(50)
    const r = formatCallToolResult({ content: [{ type: 'text', text }] }, { maxChars: 11 })
    const kept = r.text.split('\n[')[0]!
    expect(kept.length % 2).toBe(0)
    expect(kept).toBe('\u{1F600}'.repeat(kept.length / 2))
  })

  it('caps structured content too', () => {
    const r = formatCallToolResult({ structuredContent: { blob: 'y'.repeat(50_000) } }, { maxChars: 2000 })
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThan(2300)
  })

  it('has a sensible default cap', () => {
    expect(MAX_RESULT_CHARS).toBeGreaterThanOrEqual(20_000)
    expect(MAX_RESULT_CHARS).toBeLessThanOrEqual(100_000)
    const r = formatCallToolResult({ content: [{ type: 'text', text: 'z'.repeat(MAX_RESULT_CHARS + 10) }] })
    expect(r.truncated).toBe(true)
  })

  it('accepts the legacy toolResult shape', () => {
    expect(formatCallToolResult({ toolResult: { a: 1 } }).text).toBe('{"a":1}')
  })
})
