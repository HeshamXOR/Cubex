/**
 * Moving the keyboard between the changes of a diff. Each change is a group of rows marked `data-hunk` that code can focus
 * (tabindex -1), so j and k land on one, a screen reader says which change it is and what became of it, and Tab goes on to
 * its buttons from there.
 */

/** Which change a step from `current` ends on (-1 when focus is on none of them). It stops at the first and the last. */
export function nextHunkIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, current + direction))
}

/** Whether a key press is going into text, where a letter is a letter and not a shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

const hunksIn = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-hunk]')]

/** Move focus one change on and bring it to the top of the diff. False when focus is already on the first or the last. */
export function stepHunk(root: HTMLElement, direction: 1 | -1): boolean {
  const hunks = hunksIn(root)
  const here = hunks.findIndex((hunk) => hunk.contains(document.activeElement))
  const to = nextHunkIndex(here, hunks.length, direction)
  const target = hunks[to]
  if (!target || to === here) return false
  target.focus({ preventScroll: true })
  // The diff is its own scroller, so only it moves; the panels around it stay where they are.
  root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top
  return true
}

/** Whether focus has dropped to the page because what had it was taken out of the diff or switched off. */
export function focusIsLost(root: HTMLElement): boolean {
  const active = document.activeElement
  if (!active || active === document.body) return true
  return active instanceof HTMLButtonElement && active.disabled && root.contains(active)
}

/** Put focus on the change with this id, when it is still in the diff, without scrolling. */
export function focusHunk(root: HTMLElement, id: string): boolean {
  const target = hunksIn(root).find((hunk) => hunk.dataset.hunk === id)
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}
