import type { ComponentType } from 'react'

/** A settings group a feature adds on its own. Its body can use the rows in ./rows and read settings from the store. */
export interface SettingsSection {
  id: string
  title: string
  /** Lowest first. Registered sections come after Local AI and before Privacy. */
  order: number
  /** `'end'` moves the group below Privacy, to the bottom of the page. */
  placement?: 'end'
  Component: ComponentType
}

// A file in ./sections that exports `section` becomes a group on the Settings page. No other file needs editing.
const modules = import.meta.glob<{ section: SettingsSection }>('./sections/*.tsx', { eager: true })

const registered: SettingsSection[] = Object.values(modules)
  .map((mod) => mod.section)
  .filter((section): section is SettingsSection => !!section)
  .sort((a, b) => a.order - b.order)

export const extraSettingsSections: SettingsSection[] = registered.filter((section) => section.placement !== 'end')
export const closingSettingsSections: SettingsSection[] = registered.filter((section) => section.placement === 'end')
