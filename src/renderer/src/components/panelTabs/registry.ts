import type { ComponentType } from 'react'

/** The right-hand panel's built-in tabs are Changes, Plan and Details (see ReviewPanel). Anything else registers here. */
export type ExtraPanelTab = 'tasks' | 'files'

export interface PanelTabDef {
  id: ExtraPanelTab
  label: string
  /** Extra tabs sort by this after Changes, Plan and Details. */
  order: number
  Component: ComponentType
  /** A hook, called on every render: return false to hide the tab, for example while there is nothing to show. */
  useVisible?: () => boolean
  /** A hook, called on every render: a small count shown beside the label. */
  useBadge?: () => number | undefined
}

// A file in this folder named `<Something>Tab.tsx` that exports `tab` becomes a tab. No other file needs editing.
const modules = import.meta.glob<{ tab: PanelTabDef }>('./*Tab.tsx', { eager: true })

export const extraPanelTabs: PanelTabDef[] = Object.values(modules)
  .map((mod) => mod.tab)
  .filter((tab): tab is PanelTabDef => !!tab)
  .sort((a, b) => a.order - b.order)
