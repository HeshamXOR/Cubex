import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BrowserState } from '../../../shared/ipc'
import { api } from './api'

const KEY = 'cubex.browser.open'
const listeners = new Set<() => void>()

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
let open = read()

export function setBrowserPaneOpen(next: boolean): void {
  open = next
  try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* the choice just will not persist */ }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useBrowserPaneOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false)
}

/** The state of a task's page, kept current. */
export function useBrowserState(conversationId: string | undefined): BrowserState | undefined {
  const [state, setState] = useState<BrowserState>()
  useEffect(() => {
    setState(undefined)
    if (!conversationId) return
    let current = true
    void api.browserState(conversationId).then((next) => { if (current) setState(next) }).catch(() => undefined)
    const stop = api.onBrowserState((next) => { if (next.conversationId === conversationId) setState(next) })
    return () => {
      current = false
      stop()
    }
  }, [conversationId])
  return state
}
