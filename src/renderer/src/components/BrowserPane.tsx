import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Globe, RotateCw, X } from 'lucide-react'
import type { BrowserState } from '../../../shared/ipc'
import { api } from '../lib/api'
import { setBrowserPaneOpen, useBrowserState } from '../lib/browserPane'
import { useStore } from '../state/store'
import './browser.css'

/** What can draw over the pane. The page is a native view above this whole window, so it has to step aside for these. */
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], .menu, .cmdk__panel, .sheet__panel, .updd__panel'

function overlapsAnOverlay(box: DOMRect): boolean {
  for (const element of document.querySelectorAll(OVERLAYS)) {
    const other = element.getBoundingClientRect()
    if (other.width > 0 && other.height > 0 && other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top) return true
  }
  return false
}

const nothing = (conversationId: string): BrowserState => ({ conversationId, open: false, url: '', title: '', loading: false, canGoBack: false })

/** The agent's browser for this task, which the person can watch and use. The page itself is drawn by the main process. */
export function BrowserPane(): JSX.Element {
  const conversationId = useStore((s) => s.activeConversation?.id)
  const state = useBrowserState(conversationId) ?? (conversationId ? nothing(conversationId) : undefined)
  const slot = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string>()
  const showing = !!conversationId && !!state?.open

  useEffect(() => { setAddress(state?.url ?? '') }, [state?.url])
  useEffect(() => { setError(undefined) }, [conversationId])

  // Keep the page over the slot. Anything that moves the slot or draws above it comes through here.
  const place = useCallback(() => {
    const element = slot.current
    if (!element || !showing || !conversationId) return
    const box = element.getBoundingClientRect()
    if (box.width < 2 || box.height < 2 || overlapsAnOverlay(box)) void api.browserDetach()
    else void api.browserAttach(conversationId, { x: box.left, y: box.top, width: box.width, height: box.height })
  }, [conversationId, showing])

  useEffect(() => {
    const element = slot.current
    if (!element || !showing) return
    let frame = 0
    const soon = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(place)
    }
    soon()
    const resized = new ResizeObserver(soon)
    resized.observe(element)
    resized.observe(document.body)
    window.addEventListener('resize', soon)
    // Overlays come and go anywhere in the window.
    const changed = new MutationObserver(soon)
    changed.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      resized.disconnect()
      changed.disconnect()
      window.removeEventListener('resize', soon)
      void api.browserDetach()
    }
  }, [place, showing])

  const open = (event: FormEvent): void => {
    event.preventDefault()
    if (!conversationId || !address.trim()) return
    setError(undefined)
    api.browserOpen(conversationId, address.trim()).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
  }

  return (
    <div className="browser" aria-label="Browser">
      <div className="browser__bar">
        <button className="browser__btn" disabled={!conversationId || !state?.canGoBack} onClick={() => conversationId && void api.browserBack(conversationId)} aria-label="Back" title="Back">
          <ArrowLeft size={14} strokeWidth={1.75} />
        </button>
        <button className="browser__btn" disabled={!showing} onClick={() => conversationId && void api.browserReload(conversationId)} aria-label="Reload" title="Reload">
          <RotateCw size={14} strokeWidth={1.75} className={state?.loading ? 'browser__spin' : undefined} />
        </button>
        <form className="browser__address" onSubmit={open}>
          <input
            className="input mono"
            aria-label="Address"
            value={address}
            placeholder="localhost:3000"
            spellCheck={false}
            disabled={!conversationId}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button className="browser__btn" onClick={() => setBrowserPaneOpen(false)} aria-label="Close the browser" title="Close the browser">
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      {error && <p className="browser__error" role="alert">{error}</p>}
      <div className="browser__slot" ref={slot}>
        {!showing && (
          <div className="browser__empty">
            <Globe size={20} strokeWidth={1.5} aria-hidden="true" />
            <p>{conversationId ? 'Nothing is open in this task. Type an address, or ask the agent to check a page.' : 'Start a task to use the browser.'}</p>
            <p className="browser__note">It keeps none of your sign-ins, and forgets everything when Cubex closes.</p>
          </div>
        )}
      </div>
    </div>
  )
}
