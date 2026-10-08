import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS_PAGE, SETTINGS_NAV, SETTINGS_PAGES, settingsPage, type SettingsPageId } from './pages'

// The section files are read as text: importing them would pull in React, CSS and the API bridge, and what this checks
// is only how each one declares itself.
const sectionsDir = fileURLToPath(new URL('./sections/', import.meta.url))
const declaration = /export const section: SettingsSection = \{ id: '([^']+)', title: '([^']+)', page: '([^']+)', order: (\d+)/

interface Declared { file: string; id: string; title: string; page: string; order: number }

function declaredSections(): Declared[] {
  return readdirSync(sectionsDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((file) => {
      const match = declaration.exec(readFileSync(sectionsDir + file, 'utf8'))
      return match ? { file, id: match[1]!, title: match[2]!, page: match[3]!, order: Number(match[4]) } : { file, id: '', title: '', page: '', order: 0 }
    })
}

describe('settings pages', () => {
  it('lists every page once, with a name and a sentence about it', () => {
    const ids = SETTINGS_PAGES.map((page) => page.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(SETTINGS_PAGES.map((page) => page.label)).size).toBe(SETTINGS_PAGES.length)
    for (const page of SETTINGS_PAGES) {
      expect(page.label.trim()).not.toBe('')
      expect(page.description.trim().endsWith('.')).toBe(true)
    }
  })

  it('has a default page that exists, and finds a page by id', () => {
    expect(settingsPage(DEFAULT_SETTINGS_PAGE)?.id).toBe(DEFAULT_SETTINGS_PAGE)
    expect(settingsPage('about')?.label).toBe('About')
    expect(settingsPage('nothing')).toBeUndefined()
    expect(settingsPage(undefined)).toBeUndefined()
  })

  it('only labels the groups of the navigation that have a heading', () => {
    expect(SETTINGS_NAV[0]?.heading).toBeUndefined()
    for (const group of SETTINGS_NAV.slice(1)) expect(group.heading?.trim()).toBeTruthy()
  })
})

describe('settings groups', () => {
  const sections = declaredSections()
  const pageIds = new Set<string>(SETTINGS_PAGES.map((page) => page.id))

  it('declares itself in every file of the sections folder', () => {
    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) expect(section.id, `${section.file} has no section declaration`).not.toBe('')
  })

  it('puts every group on a page that exists', () => {
    for (const section of sections) expect(pageIds.has(section.page), `${section.file} names the page "${section.page}"`).toBe(true)
  })

  it('gives every group its own id, so a link can land on it', () => {
    const ids = sections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never ties two groups of one page on the same place', () => {
    const places = sections.map((section) => `${section.page}:${section.order}`)
    expect(new Set(places).size).toBe(places.length)
  })

  it('leaves no page of the navigation empty', () => {
    const used = new Set<string>(sections.map((section) => section.page))
    const empty = SETTINGS_PAGES.map((page) => page.id).filter((id: SettingsPageId) => !used.has(id))
    expect(empty).toEqual([])
  })
})
