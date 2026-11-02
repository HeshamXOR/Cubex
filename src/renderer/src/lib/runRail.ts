import { useSyncExternalStore } from 'react'

/** Below this window width the run rail steps aside so the conversation keeps its room. */
export const RAIL_MIN_WINDOW = 1100
export const RAIL_WIDTH = 292

const KEY = 'cubex.rail.collapsed'
const listeners = new Set<() => void>()

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
let collapsed = read()

export function setRailCollapsed(next: boolean): void {
  collapsed = next
  try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* the choice just will not persist */ }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The person's choice, read outside React. */
export function isRailCollapsed(): boolean {
  return collapsed
}

export function useRailCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => collapsed, () => false)
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

/**
 * Whether the rail has a place at all: the chat is open, the window is wide enough and the
 * review panel is closed (the panel takes the rail's column).
 */
export function useRailAvailable(chat: boolean, reviewOpen: boolean): boolean {
  const wide = useSyncExternalStore(subscribeResize, () => window.innerWidth >= RAIL_MIN_WINDOW, () => true)
  return chat && wide && !reviewOpen
}
