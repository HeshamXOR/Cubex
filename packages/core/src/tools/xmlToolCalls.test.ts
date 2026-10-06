import { describe, it, expect } from 'vitest'
import { parseXmlToolCalls, stripXmlToolMarkup, hasXmlToolMarkup, mapXmlToolCall } from './xmlToolCalls'

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

  it('returns nothing for plain prose', () => {
    expect(parseXmlToolCalls('just a normal answer')).toEqual([])
    expect(hasXmlToolMarkup('just a normal answer')).toBe(false)
    expect(stripXmlToolMarkup('just a normal answer')).toBe('just a normal answer')
  })

  describe('mapXmlToolCall', () => {
    const have = new Set(['list_files', 'read_file', 'search_files', 'write_file'])

    it('routes fs_read on a file to read_file', () => {
      expect(mapXmlToolCall({ name: 'fs_read', params: { path: 'src/app.ts' } }, have)).toEqual({
        name: 'read_file',
        input: { path: 'src/app.ts' }
      })
    })

    it('routes fs_read on a folder to list_files', () => {
      expect(mapXmlToolCall({ name: 'fs_read', params: { path: 'F:\\proj' } }, have)).toEqual({
        name: 'list_files',
        input: { path: 'F:\\proj' }
      })
    })

    it('maps fs_write and grep and passes unknown names through', () => {
      expect(mapXmlToolCall({ name: 'fs_write', params: { path: 'a.txt', text: 'hi' } }, have)).toEqual({
        name: 'write_file',
        input: { path: 'a.txt', content: 'hi' }
      })
      expect(mapXmlToolCall({ name: 'grep', params: { pattern: 'TODO' } }, have)).toEqual({
        name: 'search_files',
        input: { query: 'TODO' }
      })
      expect(mapXmlToolCall({ name: 'execute_bash', params: { command: 'ls' } }, have)).toEqual({
        name: 'execute_bash',
        input: { command: 'ls' }
      })
    })
  })
})
