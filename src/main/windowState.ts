/** Window placement and zoom, kept free of Electron so the rules can be tested. */

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState {
  /** The window's size and position when it is not maximized. */
  bounds?: Rect
  maximized: boolean
  zoom: number
}

export const MIN_WIDTH = 1024
export const MIN_HEIGHT = 680
export const DEFAULT_WIDTH = 1440
export const DEFAULT_HEIGHT = 900
export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.1
/** Enough of the title strip must show on a display for the window to be grabbed and moved. */
const GRAB_STRIP = { width: 120, height: 40 }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function clampZoom(zoom: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100
}

export function nextZoom(current: number, command: 'in' | 'out' | 'reset'): number {
  if (command === 'reset') return 1
  return clampZoom(current + (command === 'in' ? ZOOM_STEP : -ZOOM_STEP))
}

/** Reads a saved state, trusting nothing: the file may be old, hand-edited or damaged. */
export function parseWindowState(raw: unknown): WindowState {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const b = typeof value.bounds === 'object' && value.bounds !== null ? (value.bounds as Record<string, unknown>) : undefined
  const bounds = b && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height) && b.width > 0 && b.height > 0
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
    : undefined
  return { ...(bounds ? { bounds } : {}), maximized: value.maximized === true, zoom: clampZoom(finite(value.zoom) ? value.zoom : 1) }
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  }
}

/**
 * Where to open. The saved bounds are kept while the title strip is still reachable on a
 * connected display (a monitor may have been unplugged since), shrunk to fit that display.
 * Otherwise the window opens at its default size, which the OS centers.
 */
export function placeWindow(saved: Rect | undefined, workAreas: readonly Rect[]): { width: number; height: number; x?: number; y?: number } {
  const primary = workAreas[0]
  const fit = (width: number, height: number, area: Rect | undefined): { width: number; height: number } => ({
    width: Math.max(MIN_WIDTH, area ? Math.min(width, area.width) : width),
    height: Math.max(MIN_HEIGHT, area ? Math.min(height, area.height) : height)
  })
  if (saved) {
    const strip: Rect = { x: saved.x, y: saved.y, width: saved.width, height: GRAB_STRIP.height }
    const home = workAreas.find((area) => {
      const shared = overlap(strip, area)
      return shared.width >= GRAB_STRIP.width && shared.height >= GRAB_STRIP.height
    })
    if (home) return { ...fit(saved.width, saved.height, home), x: saved.x, y: saved.y }
  }
  return fit(DEFAULT_WIDTH, DEFAULT_HEIGHT, primary)
}
