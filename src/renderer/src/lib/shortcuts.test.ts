import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHORTCUTS, chordKeys, matchesShortcut, type KeyEventLike, type ShortcutId } from './shortcuts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const source = (path: string): string => readFileSync(join(repo, path), 'utf8')

const press = (key: string, modifiers: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })

describe('the shortcut table', () => {

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

  it('matches Escape and the arrows exactly', () => {
    expect(matches(press('Escape'), 'stop')).toBe(true)
    expect(matches(press('Escape', { ctrlKey: true }), 'stop')).toBe(false)
    expect(matches(press('ArrowUp'), 'older')).toBe(true)
    expect(matches(press('ArrowUp', { altKey: true }), 'older')).toBe(false)
  })
})
