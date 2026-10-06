import { describe, expect, it } from 'vitest'
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, ZOOM_MAX, ZOOM_MIN, clampZoom, nextZoom, parseWindowState, placeWindow, type Rect } from './windowState'

const screen1080: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('parseWindowState', () => {
  it('reads a well-formed state', () => {
    expect(parseWindowState({ bounds: { x: 10.4, y: 20, width: 1300, height: 800 }, maximized: true, zoom: 1.2 }))
      .toEqual({ bounds: { x: 10, y: 20, width: 1300, height: 800 }, maximized: true, zoom: 1.2 })
  })

  it('falls back to defaults for anything unusable', () => {
    for (const raw of [undefined, null, 'x', 7, [], {}, { bounds: 'wide', maximized: 'yes', zoom: 'big' }]) {
      expect(parseWindowState(raw), JSON.stringify(raw)).toEqual({ maximized: false, zoom: 1 })
    }
  })

  it('drops bounds that are not finite numbers or have no area', () => {
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 500 } }).bounds).toBeUndefined()
    expect(parseWindowState({ bounds: { x: NaN, y: 0, width: 500, height: 500 } }).bounds).toBeUndefined()
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: Infinity, height: 500 } }).bounds).toBeUndefined()
    expect(parseWindowState({ bounds: { x: '0', y: 0, width: 500, height: 500 } }).bounds).toBeUndefined()
  })

  it('only trusts maximized when it is exactly true', () => {
    expect(parseWindowState({ maximized: 1 }).maximized).toBe(false)
    expect(parseWindowState({ maximized: true }).maximized).toBe(true)
  })

  it('clamps a saved zoom into the supported range', () => {
    expect(parseWindowState({ zoom: 9 }).zoom).toBe(ZOOM_MAX)
    expect(parseWindowState({ zoom: 0.1 }).zoom).toBe(ZOOM_MIN)
  })
})

describe('zoom', () => {
  it('steps by a tenth and stays tidy after repeated steps', () => {
    let zoom = 1
    for (let i = 0; i < 3; i++) zoom = nextZoom(zoom, 'in')
    expect(zoom).toBe(1.3)
    for (let i = 0; i < 6; i++) zoom = nextZoom(zoom, 'out')
    expect(zoom).toBe(0.7)
  })

  it('stops at the limits', () => {
    let zoom = 1
    for (let i = 0; i < 20; i++) zoom = nextZoom(zoom, 'in')
    expect(zoom).toBe(ZOOM_MAX)
    for (let i = 0; i < 20; i++) zoom = nextZoom(zoom, 'out')
    expect(zoom).toBe(ZOOM_MIN)
  })

  it('resets to 100 percent', () => {
    expect(nextZoom(1.5, 'reset')).toBe(1)
    expect(clampZoom(1.004)).toBe(1)
  })
})

describe('placeWindow', () => {
  it('opens at the default size, centered by the OS, when nothing was saved', () => {
    expect(placeWindow(undefined, [screen1080])).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  })

  it('keeps saved bounds that are on a connected display', () => {
    expect(placeWindow({ x: 120, y: 80, width: 1300, height: 820 }, [screen1080])).toEqual({ x: 120, y: 80, width: 1300, height: 820 })
  })

  it('keeps a window on a second monitor that has negative coordinates', () => {
    expect(placeWindow({ x: -1800, y: 40, width: 1200, height: 800 }, [screen1080, leftMonitor])).toEqual({ x: -1800, y: 40, width: 1200, height: 800 })
  })

  it('forgets the position when its monitor is gone, but still opens at the default size', () => {
    expect(placeWindow({ x: -1800, y: 40, width: 1200, height: 800 }, [screen1080])).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
    expect(placeWindow({ x: 4000, y: 100, width: 1300, height: 800 }, [screen1080])).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  })

  it('needs the title strip to be reachable, not just a corner of the window', () => {
    // Only 30 px of the window's width shows at the right edge.
    expect(placeWindow({ x: 1890, y: 100, width: 1300, height: 800 }, [screen1080]).x).toBeUndefined()
    // Dragged so far down that the strip is off the bottom.
    expect(placeWindow({ x: 100, y: 1030, width: 1300, height: 800 }, [screen1080]).x).toBeUndefined()
  })

  it('shrinks a window that is bigger than its display, but never below the minimum size', () => {
    const small: Rect = { x: 0, y: 0, width: 1280, height: 720 }
    expect(placeWindow({ x: 0, y: 0, width: 2400, height: 1400 }, [small])).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    const tiny: Rect = { x: 0, y: 0, width: 900, height: 600 }
    expect(placeWindow(undefined, [tiny])).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT })
  })

  it('opens at the default size when no display is reported', () => {
    expect(placeWindow({ x: 0, y: 0, width: 1300, height: 800 }, [])).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  })
})
