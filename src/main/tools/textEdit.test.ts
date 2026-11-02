import { describe, expect, it } from 'vitest'
import { analyzeText, applyEdit } from './textEdit'

const BOM = String.fromCharCode(0xfeff)

const apply = (text: string, oldString: string, newString: string, replaceAll = false) => {
  const result = applyEdit(text, { oldString, newString, replaceAll }, 'file.txt')
  if (!result.ok) throw new Error(result.message)
  return result
}

describe('analyzeText', () => {
  it('detects the BOM, the dominant ending, and folds CRLF for matching', () => {
    const view = analyzeText(`${BOM}a\r\nb\r\nc\nd`)
    expect(view.hasBom).toBe(true)
    expect(view.eol).toBe('\r\n')
    expect(view.normalized).toBe('a\nb\nc\nd')
    expect(view.body).toBe('a\r\nb\r\nc\nd')
  })

  it('maps normalized offsets back so a CRLF is always replaced as a unit', () => {
    const view = analyzeText('ab\r\ncd\r\nef')
    // Normalized: "ab\ncd\nef". A range starting at the LF includes its CR; one ending after it includes both.
    expect(view.toBody(2)).toBe(2)
    expect(view.toBody(3)).toBe(4)
    expect(view.toBody(6)).toBe(8)
  })
})

describe('applyEdit line-break boundaries', () => {
  it('replaces a match that starts with a line break without leaving a stray CR', () => {
    expect(apply('a\r\nb\r\nc', '\nb', '\nX').text).toBe('a\r\nX\r\nc')
  })

  it('replaces a match that ends with a line break as a whole CRLF', () => {
    expect(apply('a\r\nb\r\nc', 'b\n', 'X\n').text).toBe('a\r\nX\r\nc')
  })

  it('replace_all on a bare line break replaces each CRLF and LF as a unit', () => {
    expect(apply('a\r\nb\nc\r\n', '\n', ';', true).text).toBe('a;b;c;')
  })

  it('does not interpret dollar patterns in the replacement', () => {
    expect(apply('price: X', 'X', '$& and $1 and $$').text).toBe('price: $& and $1 and $$')
  })
})
