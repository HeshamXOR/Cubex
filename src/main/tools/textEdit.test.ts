import { describe, expect, it } from 'vitest'
import { analyzeText, applyEdit, findAll, normalizeModelText, withEol } from './textEdit'

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

  it('treats a tie and an ending-free file as LF', () => {
    expect(analyzeText('a\r\nb\n').eol).toBe('\n')
    expect(analyzeText('no breaks').eol).toBe('\n')
    expect(analyzeText('').eol).toBe('\n')
  })

  it('maps normalized offsets back so a CRLF is always replaced as a unit', () => {
    const view = analyzeText('ab\r\ncd\r\nef')
    // Normalized: "ab\ncd\nef". A range starting at the LF includes its CR; one ending after it includes both.
    expect(view.toBody(2)).toBe(2)
    expect(view.toBody(3)).toBe(4)
    expect(view.toBody(6)).toBe(8)
  })

  it('keeps a lone carriage return as ordinary content', () => {
    expect(analyzeText('a\rb\r\nc').normalized).toBe('a\rb\nc')
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

  it('keeps a lone CR outside the replaced text', () => {
    expect(apply('a\rb\r\nc', 'b', 'B').text).toBe('a\rB\r\nc')
  })

  it('folds CRLF in new_string to LF for an LF file', () => {
    expect(apply('a\nb\n', 'b', 'x\r\ny').text).toBe('a\nx\ny\n')
  })

  it('handles adjacent matches and an empty replacement', () => {
    const result = apply('aaaa', 'aa', '', true)
    expect(result.text).toBe('')
    expect(result.count).toBe(2)
  })

  it('does not interpret dollar patterns in the replacement', () => {
    expect(apply('price: X', 'X', '$& and $1 and $$').text).toBe('price: $& and $1 and $$')
  })

  it('reports normalized before/after text without BOM or carriage returns', () => {
    const result = apply(`${BOM}one\r\ntwo\r\n`, 'two', 'TWO')
    expect(result.before).toBe('one\ntwo\n')
    expect(result.after).toBe('one\nTWO\n')
    expect(result.text).toBe(`${BOM}one\r\nTWO\r\n`)
  })

  it('rejects an old_string that is only a BOM and an unchanged replacement', () => {
    expect(applyEdit(`${BOM}x`, { oldString: BOM, newString: 'y' }, 'f').ok).toBe(false)
    expect(applyEdit('x\r\ny', { oldString: 'x\r\ny', newString: 'x\ny' }, 'f')).toMatchObject({ ok: false, message: expect.stringContaining('identical') })
  })
})

describe('helpers', () => {
  it('finds non-overlapping occurrences left to right', () => {
    expect(findAll('aaaaa', 'aa')).toEqual([0, 2])
    expect(findAll('abc', '')).toEqual([])
  })

  it('normalizes model text and renders line endings', () => {
    expect(normalizeModelText(`${BOM}a\r\nb`, true)).toBe('a\nb')
    expect(normalizeModelText(`${BOM}a`, false)).toBe(`${BOM}a`)
    expect(withEol('a\nb', '\r\n')).toBe('a\r\nb')
    expect(withEol('a\nb', '\n')).toBe('a\nb')
  })
})
