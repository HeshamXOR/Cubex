import { describe, expect, it } from 'vitest'
import { RegexTimeout, createLiteralMatcher, createRegexMatcher } from './regexSearch'

describe('literal line matcher', () => {
  it('matches substrings literally, folding case unless told not to', () => {
    const text = 'a.b\naxb\nA.B\n'
    expect(createLiteralMatcher('a.b', false).matchingLines(text, 10, 100)).toEqual([0, 2])
    expect(createLiteralMatcher('a.b', true).matchingLines(text, 10, 100)).toEqual([0])
  })

  it('stops at the requested number of hits', () => {
    expect(createLiteralMatcher('x', false).matchingLines('x\nx\nx\nx', 2, 100)).toEqual([0, 1])
  })
})

describe('regex line matcher', () => {
  it('returns the 0-based indexes of matching lines, up to the cap', () => {
    const matcher = createRegexMatcher('^ab+c$', false)
    expect(matcher.matchingLines('abc\nxabc\nABBC\nabbbc', 10, 100)).toEqual([0, 2, 3])
    expect(matcher.matchingLines('abc\nabbc\nabbbc', 2, 100)).toEqual([0, 1])
    expect(createRegexMatcher('^ab+c$', true).matchingLines('abc\nABBC', 10, 100)).toEqual([0])
  })

  it('lets $ match before a carriage return, so CRLF files behave like LF files', () => {
    expect(createRegexMatcher('foo$', false).matchingLines('foo\r\nbar\r\nfoo', 10, 100)).toEqual([0, 2])
  })

  it('throws the engine syntax error for an invalid pattern before doing any work', () => {
    expect(() => createRegexMatcher('(unclosed', false)).toThrow(SyntaxError)
    expect(() => createRegexMatcher('[z-a]', false)).toThrow(/invalid regular expression/i)
  })

  it('stops a catastrophic pattern at the budget and hands back the matches found before it', () => {
    const matcher = createRegexMatcher('^(x|(a+)+$)', false)
    const text = `x\nxx\n${'a'.repeat(60)}!\nx after\n`
    const started = Date.now()
    let caught: unknown
    try { matcher.matchingLines(text, 10, 200) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(RegexTimeout)
    expect((caught as RegexTimeout).partial).toEqual([0, 1])
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)

  it('is still usable after a timeout', () => {
    const matcher = createRegexMatcher('^(x|(a+)+$)', false)
    expect(() => matcher.matchingLines(`${'a'.repeat(60)}!`, 10, 100)).toThrow(RegexTimeout)
    expect(matcher.matchingLines('x\nnope\nxx', 10, 100)).toEqual([0, 2])
  }, 20_000)

  it('does not let one file leak lines into the next call', () => {
    const matcher = createRegexMatcher('needle', false)
    expect(matcher.matchingLines('needle\nneedle', 10, 100)).toEqual([0, 1])
    expect(matcher.matchingLines('nothing here', 10, 100)).toEqual([])
  })
})
