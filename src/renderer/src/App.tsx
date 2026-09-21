import { useEffect } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { RightPanel } from './components/RightPanel'
import { ChatView } from './views/ChatView'
import { ProvidersView } from './views/ProvidersView'
import { LocalModelsView } from './views/LocalModelsView'
import { ModelBrowserView } from './views/ModelBrowserView'
import { HardwareView } from './views/HardwareView'
import { BenchmarksView } from './views/BenchmarksView'
import { PresetsView } from './views/PresetsView'
import { SettingsView } from './views/SettingsView'
import { ListView } from './views/ListView'

const FONT_STACK: Record<string, string> = {
  inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  geist: "'Geist', 'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Consolas, monospace"
}
const RADIUS: Record<string, string> = { sharp: '3px', default: '10px', round: '16px' }

/** Lighten a hex color by mixing toward white (for the accent hover state). */
function lighten(hex: string, amt = 0.15): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const r = Math.min(255, ((n >> 16) & 255) + Math.round(255 * amt))
  const g = Math.min(255, ((n >> 8) & 255) + Math.round(255 * amt))
  const b = Math.min(255, (n & 255) + Math.round(255 * amt))
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

export function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const panelOpen = useStore((s) => s.panelOpen)
  const theme = useStore((s) => s.settings?.general.theme)
  const appearance = useStore((s) => s.settings?.appearance)

  useEffect(() => {
    const store = useStore.getState()
    store._initChatEvents()
    void store.loadSettings()
    void store.loadProviders()
    void store.loadPresets()
    void store.loadConversations()
  }, [])

  // Global shortcuts: Ctrl/Cmd+N new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void useStore.getState().newConversation()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const mode = theme ?? 'dark'
    const resolved =
      mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode
    document.documentElement.setAttribute('data-theme', resolved)
  }, [theme])

  // Apply appearance customization (accent, font, radius, density) as CSS vars.
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement.style
    const accent = appearance.accent || '#4f6cff'
    const hover = lighten(accent, 0.12)
    root.setProperty('--accent', accent)
    root.setProperty('--accent-hover', hover)
    root.setProperty('--brand-blue', accent)
    root.setProperty('--brand-gradient', `linear-gradient(135deg, ${accent} 0%, ${lighten(accent, 0.2)} 100%)`)
    root.setProperty('--accent-border', accent + '73')
    root.setProperty('--accent-soft', accent + '24')
    root.setProperty('--sans', FONT_STACK[appearance.font] ?? FONT_STACK.inter!)
    root.setProperty('--radius', RADIUS[appearance.radius] ?? RADIUS.default!)
    document.documentElement.setAttribute('data-density', appearance.density)
  }, [appearance])

  return (
    <div className="app">
      <Sidebar />
      <div className="app__main">
        <TitleBar />
        <div className="app__body">
          <div className="app__view">
            {view === 'chat' && <ChatView />}
            {view === 'pinned' && <ListView kind="pinned" />}
            {view === 'archive' && <ListView kind="archive" />}
            {view === 'providers' && <ProvidersView />}
            {view === 'local' && <LocalModelsView />}
            {view === 'browser' && <ModelBrowserView />}
            {view === 'hardware' && <HardwareView />}
            {view === 'benchmarks' && <BenchmarksView />}
            {view === 'presets' && <PresetsView />}
            {view === 'settings' && <SettingsView />}
          </div>
          {view === 'chat' && panelOpen && <RightPanel />}
        </div>
      </div>
    </div>
  )
}
