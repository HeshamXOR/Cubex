import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { DEFAULT_SETTINGS_PAGE, SETTINGS_NAV, settingsPage } from './settings/pages'
import { pagesWithSections, sectionsOnPage } from './settings/registry'
import { Group } from './settings/rows'

/**
 * Settings, one page at a time. The navigation lists the pages (./settings/pages) and the page shows the groups that
 * declare it (./settings/registry), so a feature adds its settings by adding a file in ./settings/sections.
 */
export function SettingsView(): JSX.Element {
  const loaded = useStore((state) => !!state.settings)
  const stored = useStore((state) => state.settingsPage)
  const setPage = useStore((state) => state.setSettingsPage)
  const scroller = useRef<HTMLDivElement>(null)

  const available = new Set(pagesWithSections().map((entry) => entry.id))
  const page = settingsPage(available.has(stored) ? stored : DEFAULT_SETTINGS_PAGE)

  // A new page starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [page?.id])

  if (!loaded || !page) return <div className="view"><div className="view__inner">Loading…</div></div>

  const sections = sectionsOnPage(page.id)
  return (
    <div className="view settings">
      <div className="settings__layout">
        <div className="settings__side">
          <h1 className="settings__title">Settings</h1>
          <nav className="setnav" aria-label="Settings pages">
            {SETTINGS_NAV.map((group, index) => {
              const pages = group.pages.filter((entry) => available.has(entry.id))
              if (pages.length === 0) return null
              return (
                <div className="setnav__group" key={group.heading ?? index}>
                  {group.heading && <div className="setnav__heading">{group.heading}</div>}
                  <ul className="setnav__list">
                    {pages.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className="setnav__item"
                          aria-current={entry.id === page.id ? 'page' : undefined}
                          onClick={() => setPage(entry.id)}
                        >
                          <entry.icon size={15} aria-hidden="true" />
                          <span>{entry.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </nav>
        </div>
        <div className="settings__scroll" ref={scroller}>
          <section className="view__inner settings__page" key={page.id} aria-labelledby="settings-page-title">
            <header className="settings__head">
              <h2 className="view__title" id="settings-page-title">{page.label}</h2>
              <p className="view__sub">{page.description}</p>
            </header>
            {sections.map(({ id, title, Component }) => (
              <Group key={id} id={id} title={title} hideTitle={sections.length === 1}>
                <Component />
              </Group>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
