import { describe, expect, it } from 'vitest'
import { pieces, tokenizeLine } from './highlight'

const classes = (line: string, lang: Parameters<typeof tokenizeLine>[1] = 'js'): string[] =>
  tokenizeLine(line, lang).filter((token) => token.cls).map((token) => `${token.cls}:${token.text}`)

describe('tokenizeLine', () => {
  it('always reproduces the line', () => {
    const line = "  const wait = res.headers.get('retry-after') // seconds"
    expect(tokenizeLine(line, 'js').map((token) => token.text).join('')).toBe(line)
    const odd = "it's \"quoted\" `tpl ${x}` 0x1F 3.14e-2 @#%"
    expect(tokenizeLine(odd, 'js').map((token) => token.text).join('')).toBe(odd)
  })

  it('colors keywords, strings, numbers, types and functions', () => {
    const tokens = classes("export async function uploadChunk(chunk: Chunk) { return fetch('x', 42) }")
    expect(tokens).toContain('k:export')
    expect(tokens).toContain('k:async')
    expect(tokens).toContain('f:uploadChunk')
    expect(tokens).toContain('p:chunk')
    expect(tokens).toContain('t:Chunk')
    expect(tokens).toContain("s:'x'")
    expect(tokens).toContain('n:42')
    expect(tokens).toContain('f:fetch')
  })

  it('colors a line comment to the end of the line', () => {
    expect(classes('x = 1 // note: it is fine')).toContain('c:// note: it is fine')
    expect(classes('x = 1 # not a comment in js').some((entry) => entry.startsWith('c:'))).toBe(false)
    expect(classes('x = 1 # comment', 'py')).toContain('c:# comment')
  })

})

describe('pieces', () => {
  it('splits tokens at the edges of marked ranges without losing text', () => {
    const line = 'throw new UploadError(res.status, wait)'
    const start = line.indexOf(', wait')
    const out = pieces(line, 'js', [[start, line.length - 1]])
    expect(out.map((piece) => piece.text).join('')).toBe(line)
    expect(out.filter((piece) => piece.marked).map((piece) => piece.text).join('')).toBe(', wait')
  })

  it('keeps the syntax class on a split token', () => {
    const out = pieces('const value = 1', 'js', [[2, 4]])
    expect(out.filter((piece) => piece.marked)).toEqual([{ text: 'ns', cls: 'k', marked: true }])
  })

})
