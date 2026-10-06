import { screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'
import { dataDir } from './paths'
import { nextZoom, parseWindowState, placeWindow, type WindowState } from './windowState'

const stateFile = (): string => join(dataDir(), 'window-state.json')

export function loadWindowState(): WindowState {
  try {
    return parseWindowState(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    return parseWindowState(undefined)
  }
}

/** Size and position for a new window, given the displays that are connected right now. */
export function windowPlacement(state: WindowState): ReturnType<typeof placeWindow> {
  return placeWindow(state.bounds, screen.getAllDisplays().map((display) => display.workArea))
}

/**
 * Remembers where the window was and how far it was zoomed, and lets Ctrl with + / - / 0
 * (or Ctrl and the wheel) zoom the interface. Cubex has no application menu, so the
 * browser's own zoom shortcuts do not exist unless they are handled here.
 */
export function trackWindow(win: BrowserWindow, initial: WindowState): void {
  let zoom = initial.zoom
  let timer: NodeJS.Timeout | undefined

  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (win.isDestroyed()) return
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), zoom }
    try {
      writeFileSync(stateFile(), JSON.stringify(state))
    } catch (err) {
      logger.warn(`Could not save the window position: ${(err as Error).message}`)
    }
  }
  const saveSoon = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  const apply = (): void => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  }
  const zoomBy = (command: 'in' | 'out' | 'reset'): void => {
    zoom = nextZoom(zoom, command)
    apply()
    saveSoon()
  }

  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  win.on('close', save)
  win.webContents.on('did-finish-load', apply)
  win.webContents.on('zoom-changed', (_event, direction) => zoomBy(direction))
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const command = input.key === '=' || input.key === '+' ? 'in' : input.key === '-' ? 'out' : input.key === '0' ? 'reset' : undefined
    if (!command) return
    event.preventDefault()
    zoomBy(command)
  })
}
