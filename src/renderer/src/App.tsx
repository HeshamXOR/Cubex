import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from './state/store'
import { isBrowserPreview } from './lib/api'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutSheet } from './components/ShortcutSheet'
import { UpdateDialog } from './components/UpdateDialog'
import { UpdateAnnouncer } from './components/UpdateNotice'
import { useUpdates } from './state/updates'
import { matchesShortcut } from './lib/shortcuts'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { ReviewPanel } from './components/ReviewPanel'
import { ChangesProvider } from './lib/useSessionChanges'
import { useNotificationBridge } from './lib/useNotificationBridge'
import { ChatView } from './views/ChatView'
import { ProvidersView } from './views/ProvidersView'
import { LocalModelsView } from './views/LocalModelsView'
import { HardwareView } from './views/HardwareView'
import { PresetsView } from './views/PresetsView'
import { SettingsView } from './views/SettingsView'

const FONT_STACK: Record<string, string> = {
  inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  geist: "'Geist', 'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Consolas, monospace"
}

/** Shift a hex color for hover feedback, retaining contrast with its label. */
function lighten(hex: string, amt = 0.15): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + Math.round(255 * amt)))
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + Math.round(255 * amt)))
  const b = Math.max(0, Math.min(255, (n & 255) + Math.round(255 * amt)))
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

function accentForeground(hex: string): string {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

const SIDE_WIDTH = 240
const GAP = 6
const REVIEW_DEFAULT = 560
const REVIEW_MIN = 380
/** The conversation never gets narrower than this; the review panel floats over it instead. */
const CONVERSATION_MIN = 440
/** Below this window width the sidebar starts out hidden. */
const SIDE_AUTO_HIDE = 1000

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function remember(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode or quota: the layout just will not persist */ }
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

export function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const panelOpen = useStore((s) => s.panelOpen)
  const theme = useStore((s) => s.settings?.general.theme)
  const appearance = useStore((s) => s.settings?.appearance)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const width = useWindowWidth()
  useNotificationBridge()
  // The sidebar follows the window until the person picks a state themselves.
  const [sidePreference, setSidePreference] = useState<boolean | undefined>(() => stored<boolean | undefined>('cubex.side', undefined))
  const sideOpen = sidePreference ?? width >= SIDE_AUTO_HIDE
  const [reviewWidth, setReviewWidth] = useState(() => stored('cubex.review', REVIEW_DEFAULT))
  const [dragging, setDragging] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const store = useStore.getState()
    store._initChatEvents()
    const loads = [store.loadSettings(), store.loadProviders(), store.loadPresets(), store.loadConversations()]

    // Design-review only: seed the story session so the layout can be reviewed in the
    // browser preview (`?seed=1&thread=1`, see lib/previewSeed.ts). The DEV check is replaced at build time, so none of
    // the preview code is part of the packaged app.
    if (import.meta.env.DEV && isBrowserPreview && /[?&](thread|done|pendingplan|compacted|review|tab|stream)\b/.test(location.search)) {
      // Wait out the initial loads, which would otherwise reset what is seeded. A busy dev server can take longer than any fixed delay.
      void Promise.allSettled(loads).then(() => window.setTimeout(() => {
        void import('./lib/previewSeed').then(({ applyPreviewSeed }) => applyPreviewSeed(location.search))
        // `?stream=1` plays a bursty live answer so smooth rendering can be reviewed.
        void import('./lib/previewStream').then(({ runPreviewStream }) => {
          ;(window as unknown as { __stream: typeof runPreviewStream }).__stream = runPreviewStream
          if (/[?&]stream\b/.test(location.search)) window.setTimeout(() => void runPreviewStream(), 600)
        })
      }, 150))
    }
  }, [])

  // The main process owns the state of updates and pushes every change; this listens for the whole life of the window.
  useEffect(() => useUpdates.getState().start(), [])

  // Global shortcuts: new session and search and commands. The keys come from lib/shortcuts.ts, which the shortcut sheet lists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (matchesShortcut(e, 'palette')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (matchesShortcut(e, 'newSession')) {
        e.preventDefault()
        void useStore.getState().newConversation()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const mode = theme ?? 'dark'
    const preference = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = (): void => {
      const resolved = mode === 'system' ? (preference.matches ? 'light' : 'dark') : mode
      document.documentElement.setAttribute('data-theme', resolved)
    }
    applyTheme()
    if (mode !== 'system') return
    preference.addEventListener('change', applyTheme)
    return () => preference.removeEventListener('change', applyTheme)
  }, [theme])

  // Apply appearance customization (accent, font, density) as CSS vars.
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement.style
    const accent = /^#[0-9a-f]{6}$/i.test(appearance.accent) ? appearance.accent : '#4f6cff'
    const foreground = accentForeground(accent)
    const hover = lighten(accent, foreground === '#000000' ? 0.08 : -0.05)
    root.setProperty('--color-brand', accent)
    root.setProperty('--color-brand-strong', hover)
    root.setProperty('--color-primary', accent)
    root.setProperty('--color-primary-foreground', foreground)
    root.setProperty('--color-accent-border', accent + '66')
    root.setProperty('--color-accent', accent + '1a')
    root.setProperty('--sans', FONT_STACK[appearance.font] ?? FONT_STACK.system!)
    document.documentElement.setAttribute('data-density', appearance.density)
  }, [appearance])

  const toggleSide = useCallback(() => {
    setSidePreference(!sideOpen)
    remember('cubex.side', !sideOpen)
  }, [sideOpen])

  // The review panel docks beside the conversation when both fit, and floats over it when not.
  const reviewVisible = view === 'chat' && panelOpen
  const room = width - (sideOpen ? SIDE_WIDTH : 0) - GAP * 2
  const maxReview = Math.max(REVIEW_MIN, room - CONVERSATION_MIN - GAP)
  const docked = room - REVIEW_MIN - GAP >= CONVERSATION_MIN
  const clamped = Math.min(Math.max(reviewWidth, REVIEW_MIN), docked ? maxReview : Math.max(REVIEW_MIN, room - 60))

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = clamped
    let latest = startWidth
    setDragging(true)
    document.body.classList.add('is-resizing')
    const move = (e: PointerEvent): void => {
      latest = Math.min(Math.max(startWidth + (startX - e.clientX), REVIEW_MIN), maxReview)
      setReviewWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      setDragging(false)
      remember('cubex.review', latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The divider is a control for the keyboard too. Left moves it left, which widens the panel.
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 96 : 24
    const next = event.key === 'ArrowLeft' ? clamped + step
      : event.key === 'ArrowRight' ? clamped - step
      : event.key === 'Home' ? REVIEW_MIN
      : event.key === 'End' ? maxReview
      : undefined
    if (next === undefined) return
    event.preventDefault()
    const width = Math.min(Math.max(next, REVIEW_MIN), maxReview)
    setReviewWidth(width)
    remember('cubex.review', width)
  }

  const columns = [sideOpen ? `${SIDE_WIDTH}px` : '', 'minmax(0, 1fr)', reviewVisible && docked ? `${clamped}px` : ''].filter(Boolean).join(' ')
  const bodyStyle = { gridTemplateColumns: columns, '--side-w': `${SIDE_WIDTH}px` } as CSSProperties

  return (
    <ChangesProvider>
    <div className="app">
      <TitleBar onSearch={() => setPaletteOpen(true)} sideOpen={sideOpen} onToggleSide={toggleSide} />
      <div className={`body ${sideOpen ? '' : 'body--bare'}`} ref={bodyRef} style={bodyStyle}>
        {sideOpen && <Sidebar />}
        <main className="panel panel--main">
          {view === 'chat' && <ChatView />}
          {view === 'providers' && <ProvidersView />}
          {view === 'local' && <LocalModelsView />}
          {view === 'hardware' && <HardwareView />}
          {view === 'presets' && <PresetsView />}
          {view === 'settings' && <SettingsView />}
        </main>
        {reviewVisible && (
          <aside className={`review-wrap ${docked ? '' : 'review-wrap--float'}`} aria-label="Review" style={docked ? undefined : { width: clamped }}>
            <div
              className={`resizer ${dragging ? 'is-dragging' : ''}`}
              onPointerDown={startResize}
              onKeyDown={resizeByKey}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize the review panel"
              aria-valuemin={REVIEW_MIN}
              aria-valuemax={Math.max(maxReview, Math.round(clamped))}
              aria-valuenow={Math.round(clamped)}
              aria-valuetext={`${Math.round(clamped)} pixels wide`}
            />
            <ReviewPanel />
          </aside>
        )}
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutSheet />
      <UpdateDialog />
      <UpdateAnnouncer />
    </div>
    </ChangesProvider>
  )
}
