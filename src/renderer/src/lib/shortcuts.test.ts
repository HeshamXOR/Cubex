import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHORTCUTS, SHORTCUT_GROUPS, chordKeys, matchesShortcut, shortcutsIn, type KeyEventLike, type ShortcutId } from './shortcuts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const source = (path: string): string => readFileSync(join(repo, path), 'utf8')

const press = (key: string, modifiers: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })

describe('the shortcut table', () => {
  it('has unique ids and lists every group', () => {
    const ids = SHORTCUTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const group of SHORTCUT_GROUPS) expect(shortcutsIn(group).length).toBeGreaterThan(0)
  })

  it('never lists the same keys twice for different things in one place', () => {
    // Esc and Enter legitimately mean different things in different places, so only the scoped pairs are checked.
    const seen = new Map<string, string>()
    for (const entry of SHORTCUTS.filter((shortcut) => shortcut.group === 'Session' && !('note' in shortcut))) {
      for (const chord of entry.chords) {
        const label = chordKeys(chord).join('+')
        expect(seen.get(label), `${label} is already ${seen.get(label)}`).toBeUndefined()
        seen.set(label, entry.id)
      }
    }
  })

  it('writes no spaced dash, dot-joined text or all-caps label', () => {
    for (const entry of SHORTCUTS) {
      for (const text of [entry.label, 'note' in entry ? entry.note : '']) {
        expect(text).not.toMatch(/ — | · /)
        expect(text).not.toMatch(/^[A-Z ]{4,}$/)
      }
    }
  })

  it('is answered by real code: each source exists and still handles its key', () => {
    for (const entry of SHORTCUTS) {
      const code = source(entry.source)
      if ('asks' in entry && entry.asks) {
        expect(code, `${entry.source} should ask matchesShortcut for ${entry.id}`).toMatch(new RegExp(`matchesShortcut\\([^)]*'${entry.id}'\\)`))
      } else {
        for (const chord of entry.chords) {
          const token = chord.key.length > 1 ? `'${chord.key}'` : chord.key
          expect(code, `${entry.source} should handle ${chord.key} for ${entry.id}`).toContain(token)
        }
      }
    }
  })
})

describe('matching a key event', () => {
  const matches = (event: KeyEventLike, id: ShortcutId): boolean => matchesShortcut(event, id)

  it('treats Ctrl and Cmd alike, and ignores the case of letters', () => {
    expect(matches(press('k', { ctrlKey: true }), 'palette')).toBe(true)
    expect(matches(press('K', { metaKey: true }), 'palette')).toBe(true)
    expect(matches(press('k'), 'palette')).toBe(false)
    expect(matches(press('k', { ctrlKey: true, shiftKey: true }), 'palette')).toBe(false)
    expect(matches(press('k', { ctrlKey: true, altKey: true }), 'palette')).toBe(false)
  })

  it('tells Enter, Ctrl Enter and Shift Enter apart', () => {
    expect(matches(press('Enter'), 'send')).toBe(true)
    expect(matches(press('Enter', { ctrlKey: true }), 'send')).toBe(true)
    expect(matches(press('Enter', { shiftKey: true }), 'send')).toBe(false)
    expect(matches(press('Enter', { shiftKey: true }), 'newline')).toBe(true)
  })

  it('tells Tab from Shift Tab', () => {
    expect(matches(press('Tab', { shiftKey: true }), 'mode')).toBe(true)
    expect(matches(press('Tab'), 'mode')).toBe(false)
    expect(matches(press('Tab'), 'complete')).toBe(true)
    expect(matches(press('Tab', { shiftKey: true }), 'complete')).toBe(false)
  })

  it('accepts Ctrl / on layouts where the slash needs Shift', () => {
    expect(matches(press('/', { ctrlKey: true }), 'shortcuts')).toBe(true)
    expect(matches(press('/', { ctrlKey: true, shiftKey: true }), 'shortcuts')).toBe(true)
    expect(matches(press('/'), 'shortcuts')).toBe(false)
  })

  it('matches Escape and the arrows exactly', () => {
    expect(matches(press('Escape'), 'stop')).toBe(true)
    expect(matches(press('Escape', { ctrlKey: true }), 'stop')).toBe(false)
    expect(matches(press('ArrowUp'), 'older')).toBe(true)
    expect(matches(press('ArrowUp', { altKey: true }), 'older')).toBe(false)
  })
})

describe('drawing a chord', () => {
  it('names keys the way they are printed on a keyboard', () => {
    expect(chordKeys({ key: 'k', mod: true })).toEqual(['Ctrl', 'K'])
    expect(chordKeys({ key: 'k', mod: true }, true)).toEqual(['Cmd', 'K'])
    expect(chordKeys({ key: 'Tab', shift: true })).toEqual(['Shift', 'Tab'])
    expect(chordKeys({ key: 'Escape' })).toEqual(['Esc'])
    expect(chordKeys({ key: 'ArrowUp' })).toEqual(['Up'])
    expect(chordKeys({ key: '/', mod: true })).toEqual(['Ctrl', '/'])
    expect(chordKeys({ key: 'Enter', alt: true })).toEqual(['Alt', 'Enter'])
  })
})
