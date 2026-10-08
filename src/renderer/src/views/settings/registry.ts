import type { ComponentType } from 'react'
import { SETTINGS_PAGES, type SettingsPageId } from './pages'

/**
 * A settings group a feature adds on its own. Its body can use the rows in ./rows and read settings from the store.
 * The group shows on the page it names, and nowhere else.
 */
export interface SettingsSection {
  id: string
  title: string
  /** The page of Settings this group is on (see ./pages). */
  page: SettingsPageId
  /** Lowest first, among the groups of the same page. */
  order: number
  Component: ComponentType
}

// A file in ./sections that exports `section` becomes a group on its page. No other file needs editing.
const modules = import.meta.glob<{ section: SettingsSection }>('./sections/*.tsx', { eager: true })

export const settingsSections: SettingsSection[] = Object.values(modules)
  .map((mod) => mod.section)
  .filter((section): section is SettingsSection => !!section)
  .sort((a, b) => a.order - b.order)

/** The groups on one page, in order. */
export function sectionsOnPage(page: SettingsPageId): SettingsSection[] {
  return settingsSections.filter((section) => section.page === page)
}

/** The page a group is on, for a link that names only the group (see lib/settingsLink). */
export function pageOfSection(id: string): SettingsPageId | undefined {
  return settingsSections.find((section) => section.id === id)?.page
}

/** Pages that have at least one group, so the navigation never leads to an empty page. */
export function pagesWithSections(): typeof SETTINGS_PAGES {
  return SETTINGS_PAGES.filter((page) => sectionsOnPage(page.id).length > 0)
}
