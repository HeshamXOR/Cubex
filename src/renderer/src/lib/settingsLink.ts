import { useStore } from '../state/store'
import { pageOfSection } from '../views/settings/registry'
import type { SettingsPageId } from '../views/settings/pages'

/** Open Settings on one of its pages. */
export function openSettingsPage(page: SettingsPageId): void {
  const state = useStore.getState()
  state.setSettingsPage(page)
  state.setView('settings')
}

/**
 * Open Settings and bring one of its groups into view, with focus on its first control. The group's page is opened
 * first. The page mounts a frame later than the switch, so the group is looked for over the next few frames.
 */
export function openSettingsGroup(id: string): void {
  const page = pageOfSection(id)
  if (page) useStore.getState().setSettingsPage(page)
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
