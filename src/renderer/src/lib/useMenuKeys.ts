import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

/** The entries of a `role="menu"`. */
const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

/** Which entry an arrow key, Home or End moves to; undefined for any other key. `current` is -1 when focus is on the menu itself. */
export function nextItem(key: string, current: number, count: number): number | undefined {
  if (count === 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
  return undefined
}

function itemsOf(menu: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(selector)).filter((item) => !item.matches(':disabled'))
}

const isChosen = (item: HTMLElement): boolean => item.getAttribute('aria-checked') === 'true' || item.classList.contains('menu__item--sel')

export interface MenuKeys {
  triggerRef: RefObject<HTMLButtonElement>
  menuRef: RefObject<HTMLDivElement>
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * Keyboard behavior for a menu that opens from a button. Focus moves into the menu when it opens (onto the
 * chosen entry, else the first), the arrow keys, Home and End move between entries, Escape closes it, and
 * focus goes back to the button unless the person has moved it somewhere on purpose. `entries` says what
 * counts as an entry; a menu that also holds a slider or other inputs leaves their keys alone.
 */
export function useMenuKeys(open: boolean, close: () => void, entries = MENU_ITEMS): MenuKeys {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const items = menu ? itemsOf(menu, entries) : []
    ;(items.find(isChosen) ?? items[0] ?? menu)?.focus()
    return () => {
      // The menu is gone by now, so focus that was inside it has fallen back to the page.
      const active = document.activeElement
      if (!active || active === document.body) triggerRef.current?.focus()
    }
  }, [open, entries])

  // Escape works wherever focus is, and does nothing else: it must not also stop the turn behind the menu.
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const menu = menuRef.current
    if (!menu) return
    const items = itemsOf(menu, entries)
    const current = items.indexOf(event.target as HTMLElement)
    // A slider or field inside the menu keeps its own arrow keys.
    if (current < 0 && event.target !== menu) return
    const next = nextItem(event.key, current, items.length)
    if (next === undefined) return
    event.preventDefault()
    items[next]?.focus()
  }

  return { triggerRef, menuRef, onKeyDown }
}
