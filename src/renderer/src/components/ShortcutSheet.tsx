import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useShortcutSheet } from '../state/shortcutSheet'
import { SHORTCUT_GROUPS, chordKeys, isMac, matchesShortcut, shortcutsIn, type ShortcutDef } from '../lib/shortcuts'
import './shortcuts.css'

function Keys({ shortcut }: { shortcut: ShortcutDef }): JSX.Element {
  return (
    <span className="sheet__keys">
      {shortcut.chords.map((chord, index) => (
        <span className="sheet__chord" key={index}>
          {index > 0 && <span className="sheet__or">or</span>}
          {chordKeys(chord, isMac).map((cap, position) => <kbd key={position}>{cap}</kbd>)}
        </span>
      ))}
    </span>
  )
}

/** Every keyboard shortcut, grouped by where it works. The list is lib/shortcuts.ts, the same table the handlers read. */
export function ShortcutSheet(): JSX.Element | null {
  const open = useShortcutSheet((state) => state.open)
  const setOpen = useShortcutSheet((state) => state.setOpen)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Ctrl+/ toggles from anywhere. While the sheet is open it owns the keyboard: Esc closes it
  // instead of stopping the turn behind it, and other shortcuts wait.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, 'shortcuts')) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(!useShortcutSheet.getState().open)
        return
      }
      if (!useShortcutSheet.getState().open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeRef.current?.focus()
      } else if (event.ctrlKey || event.metaKey) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setOpen])

  // Focus moves into the sheet, and back to where it was when the sheet closes.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    return () => { if (previous && document.contains(previous)) previous.focus() }
  }, [open])

  if (!open) return null
  return (
    <div className="sheet" onClick={() => setOpen(false)}>
      <div className="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1} ref={panelRef} onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <h2 id="sheet-title">Keyboard shortcuts</h2>
          <button ref={closeRef} className="ib" onClick={() => setOpen(false)} aria-label="Close" title="Close"><X size={15} /></button>
        </div>
        <div className="sheet__body">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group} className={`sheet__group sheet__group--${group.toLowerCase()}`} aria-labelledby={`sheet-group-${group}`}>
              <h3 id={`sheet-group-${group}`}>{group}</h3>
              <ul>
                {shortcutsIn(group).map((shortcut) => (
                  <li key={shortcut.id}>
                    <span className="sheet__what">
                      {shortcut.label}
                      {'note' in shortcut && shortcut.note && <span className="sheet__note">{shortcut.note}</span>}
                    </span>
                    <Keys shortcut={shortcut} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
