import { useEffect, useState } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { api } from '../lib/api'
import { CubexMark } from '../theme/Logo'

interface TitleBarProps {
  onSearch: () => void
  sideOpen: boolean
  onToggleSide: () => void
}

/** The Windows caption glyphs, drawn thin like the system ones. */
function Caption({ maximized, onToggle }: { maximized: boolean; onToggle: () => void }): JSX.Element {
  return (
    <div className="caption">
      <button onClick={() => void api.windowMinimize()} aria-label="Minimize">
        <svg viewBox="0 0 10 10"><path d="M0 5.5h10" /></svg>
      </button>
      <button onClick={onToggle} aria-label={maximized ? 'Restore window' : 'Maximize'}>
        {maximized
          ? <svg viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /></svg>
          : <svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1" /></svg>}
      </button>
      <button className="close" onClick={() => void api.windowClose()} aria-label="Close">
        <svg viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  )
}

export function TitleBar({ onSearch, sideOpen, onToggleSide }: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized)
    // The caption button swaps its glyph when the window is maximized or restored by any means.
    const onResize = (): void => void api.windowIsMaximized().then(setMaximized)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <header className="tb">
      <div className={`tb-app ${sideOpen ? '' : 'tb-app--collapsed'}`}>
        <CubexMark size={16} className="mark" />
        Cubex
        <button className="tb-toggle" onClick={onToggleSide} aria-label="Sidebar" aria-pressed={sideOpen} title={sideOpen ? 'Hide sidebar' : 'Show sidebar'}>
          <PanelLeft size={16} />
        </button>
      </div>
      <button className="tb-search" onClick={onSearch} aria-keyshortcuts="Control+K">
        <Search size={14} />
        <span>Search sessions, files and commands</span>{' '}
        <kbd>Ctrl K</kbd>
      </button>
      <Caption maximized={maximized} onToggle={() => void api.windowToggleMaximize().then(setMaximized)} />
    </header>
  )
}
