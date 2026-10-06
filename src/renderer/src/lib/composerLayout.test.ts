import { describe, expect, it } from 'vitest'
import { PLACEHOLDERS, SNUG_BELOW, TIGHT_BELOW, densityFor, pickFitting, situationOf, type SituationInput } from './composerLayout'

/** Eight pixels a character: easy to reason about, and the same order of size as the real field. */
const measure = (text: string): number => text.length * 8

const input = (extra: Partial<SituationInput> = {}): SituationInput =>
  ({ ready: true, hasProviders: true, localOnly: false, compacting: false, asking: false, planning: false, working: false, ...extra })

describe('how much of the bar fits', () => {
  it('keeps everything on a wide composer and gives up words as it narrows', () => {
    expect(densityFor(720)).toBe('roomy')
    expect(densityFor(SNUG_BELOW)).toBe('roomy')
    expect(densityFor(SNUG_BELOW - 1)).toBe('snug')
    expect(densityFor(TIGHT_BELOW)).toBe('snug')
    expect(densityFor(TIGHT_BELOW - 1)).toBe('tight')
    expect(densityFor(300)).toBe('tight')
  })

  it('treats a composer that has not been measured yet as wide', () => {
    expect(densityFor(0)).toBe('roomy')
  })
})

describe('choosing a placeholder that fits', () => {
  const wordings = ['a long sentence that says everything', 'a shorter one', 'short']

  it('uses the full wording when it fits and the longest that fits when it does not', () => {
    expect(pickFitting(wordings, 1000, measure)).toBe(wordings[0])
    expect(pickFitting(wordings, 13 * 8, measure)).toBe('a shorter one')
    expect(pickFitting(wordings, 5 * 8, measure)).toBe('short')
  })

  it('falls back to the shortest when nothing fits, and to the full wording before the first measurement', () => {
    expect(pickFitting(wordings, 8, measure)).toBe('short')
    expect(pickFitting(wordings, 0, measure)).toBe(wordings[0])
    expect(pickFitting([], 100, measure)).toBe('')
  })

  it('picks the shortened idle wording in the field the review panel leaves at 900 px', () => {
    // About 330 px of field (a 390 px box less its padding) at roughly 6.6 px a character.
    expect(pickFitting(PLACEHOLDERS.idle, 330, (text) => text.length * 6.6)).toBe('Ask Cubex, @ for files, / for commands')
    expect(pickFitting(PLACEHOLDERS.idle, 640, (text) => text.length * 6.6)).toBe(PLACEHOLDERS.idle[0])
  })
})

describe('what the composer is for', () => {
  it('asks for a model or a provider before anything else', () => {
    expect(situationOf(input({ ready: false }))).toBe('select-model')
    expect(situationOf(input({ ready: false, hasProviders: false }))).toBe('add-provider')
    expect(situationOf(input({ ready: false, hasProviders: false, localOnly: true }))).toBe('add-local-provider')
    expect(situationOf(input({ ready: false, working: true }))).toBe('select-model')
  })

  it('tells what the turn is waiting for, in the order the person has to act', () => {
    expect(situationOf(input({ working: true, compacting: true, asking: true, planning: true }))).toBe('summarizing')
    expect(situationOf(input({ working: true, asking: true, planning: true }))).toBe('answer')
    expect(situationOf(input({ working: true, planning: true }))).toBe('plan')
    expect(situationOf(input({ working: true }))).toBe('working')
    expect(situationOf(input())).toBe('idle')
  })
})

describe('the placeholder wording', () => {
  it('runs from the full wording to the shortest, and tells that Enter queues while a turn runs or waits', () => {
    for (const [situation, choices] of Object.entries(PLACEHOLDERS)) {
      const lengths = choices.map((text) => text.length)
      expect(lengths, situation).toEqual([...lengths].sort((a, b) => b - a))
    }
    for (const situation of ['summarizing', 'answer', 'plan', 'working'] as const) expect(PLACEHOLDERS[situation][0]).toMatch(/Enter queues|Press Enter to queue/)
  })

  it('uses no spaced dash, dot-joined text or all-caps label', () => {
    for (const choices of Object.values(PLACEHOLDERS)) {
      for (const text of choices) {
        expect(text).not.toMatch(/ — | · /)
        expect(text).not.toMatch(/^[A-Z ]{4,}$/)
      }
    }
  })
})
