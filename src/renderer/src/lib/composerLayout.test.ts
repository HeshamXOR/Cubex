import { describe, expect, it } from 'vitest'
import { PLACEHOLDERS, SNUG_BELOW, TIGHT_BELOW, densityFor, pickFitting } from './composerLayout'

/** Eight pixels a character: easy to reason about, and the same order of size as the real field. */
const measure = (text: string): number => text.length * 8

describe('how much of the bar fits', () => {
  it('keeps everything on a wide composer and gives up words as it narrows', () => {
    expect(densityFor(720)).toBe('roomy')
    expect(densityFor(SNUG_BELOW)).toBe('roomy')
    expect(densityFor(SNUG_BELOW - 1)).toBe('snug')
    expect(densityFor(TIGHT_BELOW)).toBe('snug')
    expect(densityFor(TIGHT_BELOW - 1)).toBe('tight')
    expect(densityFor(300)).toBe('tight')
  })

})

describe('choosing a placeholder that fits', () => {
  const wordings = ['a long sentence that says everything', 'a shorter one', 'short']

  it('uses the full wording when it fits and the longest that fits when it does not', () => {
    expect(pickFitting(wordings, 1000, measure)).toBe(wordings[0])
    expect(pickFitting(wordings, 13 * 8, measure)).toBe('a shorter one')
    expect(pickFitting(wordings, 5 * 8, measure)).toBe('short')
  })

  it('picks the shortened idle wording in the field the review panel leaves at 900 px', () => {
    // About 330 px of field (a 390 px box less its padding) at roughly 6.6 px a character.
    expect(pickFitting(PLACEHOLDERS.idle, 330, (text) => text.length * 6.6)).toBe('Ask Cubex, @ for files, / for commands')
    expect(pickFitting(PLACEHOLDERS.idle, 640, (text) => text.length * 6.6)).toBe(PLACEHOLDERS.idle[0])
  })
})
