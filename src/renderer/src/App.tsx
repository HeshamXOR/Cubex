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

export function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const panelOpen = useStore((s) => s.panelOpen)
  const theme = useStore((s) => s.settings?.general.theme)

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
