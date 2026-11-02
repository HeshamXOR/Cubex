import { describe, it, expect } from 'vitest'
import { parseXmlToolCalls, stripXmlToolMarkup, hasXmlToolMarkup } from './xmlToolCalls'

describe('xmlToolCalls', () => {
  it('parses a single invoke with parameters', () => {
    const t = 'I will look.\n<invoke name="fs_read"><parameter name="path">F:\\proj</parameter></invoke>'
    const calls = parseXmlToolCalls(t)
    expect(calls).toEqual([{ name: 'fs_read', params: { path: 'F:\\proj' } }])
  })

  it('parses multiple invokes, tolerating whitespace and multiline values', () => {
    const t =
      '<invoke name="list_files"> <parameter name="path">.</parameter> </invoke>\n' +
      '<invoke name="write_file"><parameter name="path">a.txt</parameter><parameter name="content">line1\nline2</parameter></invoke>'
    const calls = parseXmlToolCalls(t)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ name: 'list_files', params: { path: '.' } })
    expect(calls[1]).toEqual({ name: 'write_file', params: { path: 'a.txt', content: 'line1\nline2' } })
  })

  it('detects markup and strips it from prose', () => {
    const t = 'Here goes:\n<invoke name="fs_read"><parameter name="path">x</parameter></invoke>\nDone.'
    expect(hasXmlToolMarkup(t)).toBe(true)
    expect(stripXmlToolMarkup(t)).toBe('Here goes:\n\nDone.')
  })

  it('strips a truncated (unclosed) invoke left by a cut stream', () => {
    const t = 'Reading now <invoke name="fs_read"><parameter name="path">big'
    expect(stripXmlToolMarkup(t)).toBe('Reading now')
    expect(parseXmlToolCalls(t)).toEqual([])
  })
})
