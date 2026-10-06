/**
 * Every keyboard shortcut Cubex has, in one place. The sheet that lists them reads this table, and the
 * handlers that act on them ask it whether a key event is theirs (`matchesShortcut`), so what the sheet says
 * and what the keys do cannot drift apart. A shortcut belongs here only when real code answers it: the test
 * next to this file reads each `source` and fails when the handler is gone.
 */

export type ShortcutGroup = 'Session' | 'Composer' | 'Review'

export interface Chord {
  /** A `KeyboardEvent.key` value: 'k', 'Enter', 'Escape', 'ArrowUp', '/'. */
  key: string
  /** Ctrl, or Cmd on a Mac. */
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

export interface ShortcutDef {
  id: string
  group: ShortcutGroup
  label: string
  /** When it applies, when that is not always. */
  note?: string
  /** Alternatives: any one of them does it. */
  chords: readonly Chord[]
  /** The file whose code answers it, relative to the repository root. */
  source: string
  /** True when that code asks `matchesShortcut` rather than testing the key itself. */
  asks?: boolean
}

const APP = 'src/renderer/src/App.tsx'
const COMPOSER = 'src/renderer/src/components/chat/Composer.tsx'
const CHAT = 'src/renderer/src/views/ChatView.tsx'
const SHEET = 'src/renderer/src/components/ShortcutSheet.tsx'
const HUNKS = 'src/renderer/src/components/HunkDiff.tsx'

export const SHORTCUTS = [
  { id: 'palette', group: 'Session', label: 'Search sessions, files and commands', chords: [{ key: 'k', mod: true }], source: APP, asks: true },
  { id: 'newSession', group: 'Session', label: 'New session', chords: [{ key: 'n', mod: true }], source: APP, asks: true },
  { id: 'shortcuts', group: 'Session', label: 'Keyboard shortcuts', chords: [{ key: '/', mod: true }], source: SHEET, asks: true },
  { id: 'stop', group: 'Session', label: 'Stop the running turn', chords: [{ key: 'Escape' }], source: CHAT, asks: true },
  { id: 'allow', group: 'Session', label: 'Allow what the approval card asks', note: 'When the composer is empty', chords: [{ key: 'Enter' }], source: 'src/renderer/src/components/chat/PermissionCard.tsx' },
  { id: 'deny', group: 'Session', label: 'Deny what the approval card asks', note: 'When an approval card is waiting', chords: [{ key: 'Escape' }], source: 'src/renderer/src/components/chat/PermissionCard.tsx' },

  { id: 'send', group: 'Composer', label: 'Send, or queue while a turn runs', chords: [{ key: 'Enter' }, { key: 'Enter', mod: true }], source: COMPOSER, asks: true },
  { id: 'newline', group: 'Composer', label: 'New line', chords: [{ key: 'Enter', shift: true }], source: COMPOSER, asks: true },
  { id: 'older', group: 'Composer', label: 'Previous prompt', note: 'In an empty composer or at the start of a draft', chords: [{ key: 'ArrowUp' }], source: COMPOSER, asks: true },
  { id: 'newer', group: 'Composer', label: 'Next prompt', note: 'While going back through prompts', chords: [{ key: 'ArrowDown' }], source: COMPOSER, asks: true },
  { id: 'draft', group: 'Composer', label: 'Back to your draft', note: 'While going back through prompts', chords: [{ key: 'Escape' }], source: COMPOSER, asks: true },
  { id: 'mode', group: 'Composer', label: 'Change what Cubex may do without asking', chords: [{ key: 'Tab', shift: true }], source: COMPOSER, asks: true },
  { id: 'complete', group: 'Composer', label: 'Complete the command, skill or file', note: 'When its list is open', chords: [{ key: 'Tab' }], source: COMPOSER, asks: true },
  { id: 'mention', group: 'Composer', label: 'Add a file', note: 'Type it, then a name', chords: [{ key: '@' }], source: COMPOSER },
  { id: 'commands', group: 'Composer', label: 'Run a command or a skill', note: 'Type it first in the message', chords: [{ key: '/' }], source: COMPOSER },

  { id: 'reviewTabs', group: 'Review', label: 'Switch review tab', note: 'With a tab focused', chords: [{ key: 'ArrowLeft' }, { key: 'ArrowRight' }], source: 'src/renderer/src/components/ReviewPanel.tsx' },
  { id: 'commit', group: 'Review', label: 'Commit the selected files', note: 'In the commit sheet', chords: [{ key: 'Enter', mod: true }], source: 'src/renderer/src/components/CommitSheet.tsx' },
  { id: 'closeCommit', group: 'Review', label: 'Close the commit sheet', chords: [{ key: 'Escape' }], source: 'src/renderer/src/components/CommitSheet.tsx' },
  { id: 'commentAdd', group: 'Review', label: 'Add or save the comment', note: 'In a comment box under a change', chords: [{ key: 'Enter', mod: true }], source: 'src/renderer/src/components/CommentEditor.tsx' },
  { id: 'commentCancel', group: 'Review', label: 'Discard the comment', note: 'In a comment box under a change', chords: [{ key: 'Escape' }], source: 'src/renderer/src/components/CommentEditor.tsx' },
  { id: 'nextHunk', group: 'Review', label: 'Go to the next change', note: 'With a change focused, not while typing', chords: [{ key: 'j' }], source: HUNKS, asks: true },
  { id: 'prevHunk', group: 'Review', label: 'Go to the previous change', note: 'With a change focused, not while typing', chords: [{ key: 'k' }], source: HUNKS, asks: true }
] as const satisfies readonly ShortcutDef[]

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** The fields of a keyboard event the table looks at, so native and React events both fit. */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

function matchesChord(event: KeyEventLike, chord: Chord): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false
  if ((event.ctrlKey || event.metaKey) !== !!chord.mod || event.altKey !== !!chord.alt) return false
  // A symbol such as / needs Shift on some keyboard layouts, so Shift only counts for letters and named keys.
  const symbol = chord.key.length === 1 && !/[a-z0-9]/i.test(chord.key)
  return symbol || event.shiftKey === !!chord.shift
}

/** Whether a key event is this shortcut. The handlers use this, so the sheet and the keys share one definition. */
export function matchesShortcut(event: KeyEventLike, id: ShortcutId): boolean {
  const shortcut: ShortcutDef = SHORTCUTS.find((entry) => entry.id === id)!
  return shortcut.chords.some((chord) => matchesChord(event, chord))
}

const KEY_NAMES: Record<string, string> = {
  Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space'
}

/** The caps to draw for a chord, in the order they are pressed: ['Ctrl', 'K'], ['Shift', 'Tab']. */
export function chordKeys(chord: Chord, mac = false): string[] {
  const key = KEY_NAMES[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return [...(chord.mod ? [mac ? 'Cmd' : 'Ctrl'] : []), ...(chord.alt ? [mac ? 'Option' : 'Alt'] : []), ...(chord.shift ? ['Shift'] : []), key]
}

/** Whether this machine is a Mac, where the command key does what Ctrl does elsewhere. */
export const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** A shortcut's first chord as one line, for a hint beside a menu item: "Ctrl K". */
export function shortcutHint(id: ShortcutId): string {
  const shortcut: ShortcutDef = SHORTCUTS.find((entry) => entry.id === id)!
  return chordKeys(shortcut.chords[0]!, isMac).join(' ')
}

/** The shortcuts of one group, in the order they are declared. */
export function shortcutsIn(group: ShortcutGroup): readonly ShortcutDef[] {
  return SHORTCUTS.filter((entry) => entry.group === group)
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Session', 'Composer', 'Review']
