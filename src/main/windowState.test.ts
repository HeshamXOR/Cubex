import { describe, expect, it } from 'vitest'
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, parseWindowState, placeWindow, type Rect } from './windowState'

const screen1080: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('parseWindowState', () => {

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
})

describe('placeWindow', () => {

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
})
