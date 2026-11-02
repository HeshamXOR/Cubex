import { describe, expect, it } from 'vitest'
import { countLines, detectLineEnding, splitLines } from './workspaceFile'

describe('splitLines', () => {
  it('splits LF, CRLF and lone CR files into the same lines', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c'])
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('treats a final line break as the end of the last line, not another line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('')).toEqual([])
  })

})

describe('countLines', () => {
  it('agrees with splitLines for every shape of ending', () => {
    for (const text of ['', 'a', 'a\n', 'a\r\n', 'a\rb', 'a\r\nb\r\n', '\n', '\r\n', 'a\n\nb\n', 'a\r\n\rb', 'x\r', '\r\r\n\n']) {
      expect(countLines(text), JSON.stringify(text)).toBe(splitLines(text).length)
    }
  })

})

describe('detectLineEnding', () => {
  it('names the ending a file uses', () => {
    expect(detectLineEnding('one line')).toBe('none')
    expect(detectLineEnding('a\nb\n')).toBe('lf')
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf')
    expect(detectLineEnding('a\rb\r')).toBe('cr')
  })

  it('calls a file mixed when it uses more than one', () => {
    expect(detectLineEnding('a\r\nb\nc')).toBe('mixed')
    expect(detectLineEnding('a\rb\n')).toBe('mixed')
  })
})
