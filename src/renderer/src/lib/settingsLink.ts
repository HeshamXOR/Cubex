import { useStore } from '../state/store'

/**
 * Open Settings and bring one of its groups into view, with focus on its first control. The page mounts a
 * frame later than the switch, so the group is looked for over the next few frames.
 */
export function openSettingsGroup(id: string): void {
  useStore.getState().setView('settings')
  const reveal = (framesLeft: number): void => {
    const group = document.getElementById(`settings-${id}`)
    if (group) {
      group.scrollIntoView({ block: 'start' })
      group.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
      return
    }
    if (framesLeft > 0) requestAnimationFrame(() => reveal(framesLeft - 1))
  }
  requestAnimationFrame(() => reveal(12))
}
