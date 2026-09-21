import { useEffect, useState } from 'react'
import { Copy, Minus, PanelRight, Pencil, Plus, Search, Square, X } from 'lucide-react'
import { useStore, type ViewId } from '../state/store'
import { StatusIndicator } from '../status/StatusIndicator'
import { api } from '../lib/api'
import { CubexMark } from '../theme/Logo'

const VIEW_TITLES: Record<string, string> = {
  providers: 'Providers',
  local: 'Local Models',
  browser: 'Model Browser',
  hardware: 'Hardware Analyzer',
  benchmarks: 'Benchmarks',
  presets: 'Presets',
  settings: 'Settings',
  pinned: 'Pinned',
  archive: 'Archive'
}

export function TitleBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)
  const renameActiveConversation = useStore((s) => s.renameActiveConversation)
  const newConversation = useStore((s) => s.newConversation)
  const status = useStore((s) => s.status)
  const statusDetail = useStore((s) => s.statusDetail)
  const genStartedAt = useStore((s) => s.genStartedAt)
  const panelOpen = useStore((s) => s.panelOpen)
  const togglePanel = useStore((s) => s.togglePanel)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized)
  }, [])

  const isChat = view === 'chat'

  const rename = (id: string, current: string): void => {
    const next = window.prompt('Rename conversation', current)
    if (next && next.trim()) void renameActiveConversation(id, next.trim())
  }

  return (
    <div className="titlebar">
      {isChat ? (
        <>
          <div className="tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${activeTabId === t.id ? 'tab--active' : ''}`}
                onClick={() => void selectTab(t.id)}
              >
                <CubexMark size={13} />
                <span className="tab__name">{t.title}</span>
                {activeTabId === t.id ? (
                  <span
                    className="tab__act"
                    role="button"
                    tabIndex={-1}
                    aria-label="Rename"
                    onClick={(e) => {
                      e.stopPropagation()
                      rename(t.id, t.title)
                    }}
                  >
                    <Pencil size={12.5} />
                  </span>
                ) : (
                  <span
                    className="tab__act"
                    role="button"
                    tabIndex={-1}
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t.id)
                    }}
                  >
                    <X size={13} />
                  </span>
                )}
              </div>
            ))}
          </div>
          <button className="titlebar__newtab" onClick={() => void newConversation()} title="New chat tab">
            <Plus size={16} />
          </button>
        </>
      ) : (
        <div className="tab tab--active" style={{ cursor: 'default' }}>
          <span className="tab__name" style={{ fontWeight: 600 }}>
            {VIEW_TITLES[view] ?? 'Cubex'}
          </span>
        </div>
      )}

      <div className="titlebar__spacer" />

      <div className="titlebar__actions">
        <StatusIndicator state={status} detail={statusDetail} startedAt={genStartedAt} />
        <button className="iconbtn" title="Search conversations" onClick={() => setView('chat' as ViewId)}>
          <Search size={16} />
        </button>
        {isChat && (
          <button
            className={`iconbtn ${panelOpen ? 'iconbtn--on' : ''}`}
            title="Toggle parameters & inspector"
            onClick={togglePanel}
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>

      <div className="wincontrols">
        <button className="wincontrol" onClick={() => void api.windowMinimize()} aria-label="Minimize">
          <Minus size={15} />
        </button>
        <button
          className="wincontrol"
          onClick={() => void api.windowToggleMaximize().then(setMaximized)}
          aria-label="Maximize"
        >
          {maximized ? <Copy size={12.5} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12.5} />}
        </button>
        <button className="wincontrol wincontrol--close" onClick={() => void api.windowClose()} aria-label="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
