import { describe, it, expect } from 'vitest'
import { lineDiff, condenseDiff, serializeDiff } from './lineDiff'

describe('lineDiff', () => {
  it('marks identical text as all context', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(d.every((l) => l.tag === ' ')).toBe(true)
    expect(d).toHaveLength(3)
  })

  it('detects a single-line replacement', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d.map((l) => l.tag).join('')).toBe(' -+ ')
    expect(d.find((l) => l.tag === '+')?.text).toBe('B')
    expect(d.find((l) => l.tag === '-')?.text).toBe('b')
  })

  it('handles pure additions and deletions', () => {
    expect(lineDiff('', 'x\ny').every((l) => l.tag === '+')).toBe(true)
    expect(lineDiff('x\ny', '').every((l) => l.tag === '-')).toBe(true)
  })

  it('condenses long unchanged runs into a gap marker', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const after = before.replace('line15', 'CHANGED')
    const condensed = condenseDiff(lineDiff(before, after), 2)
    // Far-away context is hidden behind '@' markers.
    expect(condensed.some((l) => l.tag === '@')).toBe(true)
    expect(condensed.length).toBeLessThan(30)
    expect(condensed.some((l) => l.tag === '+' && l.text === 'CHANGED')).toBe(true)
  })

  it('serializes with the tag as the first character', () => {
    expect(serializeDiff([{ tag: '+', text: 'foo' }, { tag: '-', text: 'bar' }])).toBe('+foo\n-bar')
  })
})
