import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '@shared/settings'
import { THROTTLE_MS, decideNotification, inBackground, wantsAttention, type DecisionInput, type WindowState } from './decide'

const FRONT: WindowState = { focused: true, minimized: false, visible: true }
const BACK: WindowState = { focused: false, minimized: false, visible: true }

const input = (patch: Partial<DecisionInput> = {}): DecisionInput => ({
  kind: 'finished',
  conversationId: 'a',
  settings: DEFAULT_NOTIFICATIONS,
  window: BACK,
  onScreen: 'a',
  lastShownAt: undefined,
  now: 100_000,
  ...patch
})
const settings = (patch: Partial<NotificationSettings>): NotificationSettings => ({ ...DEFAULT_NOTIFICATIONS, ...patch })

describe('inBackground', () => {
  it('is true for an unfocused, minimized or hidden window', () => {
    expect(inBackground(FRONT)).toBe(false)
    expect(inBackground(BACK)).toBe(true)
    expect(inBackground({ ...FRONT, minimized: true })).toBe(true)
    expect(inBackground({ ...FRONT, visible: false })).toBe(true)
  })
})

describe('decideNotification switches', () => {
  it('shows nothing when the master switch is off', () => {
    for (const kind of ['needsMe', 'finished', 'failed'] as const) {
      expect(decideNotification(input({ kind, settings: settings({ enabled: false }) }))).toEqual({ show: false, reason: 'disabled' })
    }
  })

  it('honours each kind on its own', () => {
    expect(decideNotification(input({ kind: 'needsMe', settings: settings({ needsMe: false }) }))).toEqual({ show: false, reason: 'type-off' })
    expect(decideNotification(input({ kind: 'finished', settings: settings({ finished: false }) }))).toEqual({ show: false, reason: 'type-off' })
    expect(decideNotification(input({ kind: 'failed', settings: settings({ failed: false }) }))).toEqual({ show: false, reason: 'type-off' })
    expect(decideNotification(input({ kind: 'failed', settings: settings({ finished: false }) }))).toEqual({ show: true })
  })

  it('shows all three kinds by default while the window is in the background', () => {
    for (const kind of ['needsMe', 'finished', 'failed'] as const) expect(decideNotification(input({ kind }))).toEqual({ show: true })
  })
})

describe('decideNotification focus and session', () => {
  it('stays quiet about the session the person is looking at', () => {
    for (const kind of ['needsMe', 'finished', 'failed'] as const) {
      expect(decideNotification(input({ kind, window: FRONT, onScreen: 'a' }))).toEqual({ show: false, reason: 'watching' })
      expect(decideNotification(input({ kind, window: FRONT, onScreen: 'a', settings: settings({ onlyInBackground: false }) }))).toEqual({ show: false, reason: 'watching' })
    }
  })

  it('stays quiet about another session in a window that is in front, unless background-only is off', () => {
    expect(decideNotification(input({ window: FRONT, onScreen: 'b' }))).toEqual({ show: false, reason: 'foreground' })
    expect(decideNotification(input({ window: FRONT, onScreen: null }))).toEqual({ show: false, reason: 'foreground' })
    expect(decideNotification(input({ window: FRONT, onScreen: 'b', settings: settings({ onlyInBackground: false }) }))).toEqual({ show: true })
    expect(decideNotification(input({ window: FRONT, onScreen: null, settings: settings({ onlyInBackground: false }) }))).toEqual({ show: true })
  })

  it('tells the person about the session on screen when they are in another window', () => {
    expect(decideNotification(input({ window: BACK, onScreen: 'a' }))).toEqual({ show: true })
    expect(decideNotification(input({ window: { ...FRONT, minimized: true }, onScreen: 'a' }))).toEqual({ show: true })
  })
})

describe('decideNotification throttle', () => {
  it('lets one notification through per session per five seconds', () => {
    const base = { now: 100_000 }
    expect(decideNotification(input({ ...base, lastShownAt: 100_000 - 1 }))).toEqual({ show: false, reason: 'throttled', retryAt: 100_000 - 1 + THROTTLE_MS })
    expect(decideNotification(input({ ...base, lastShownAt: 100_000 - (THROTTLE_MS - 1) }))).toMatchObject({ show: false, reason: 'throttled' })
    expect(decideNotification(input({ ...base, lastShownAt: 100_000 - THROTTLE_MS }))).toEqual({ show: true })
    expect(decideNotification(input({ ...base, lastShownAt: undefined }))).toEqual({ show: true })
  })

  it('reports a more basic reason before the throttle', () => {
    expect(decideNotification(input({ lastShownAt: 99_999, settings: settings({ enabled: false }) }))).toEqual({ show: false, reason: 'disabled' })
    expect(decideNotification(input({ lastShownAt: 99_999, window: FRONT, onScreen: 'a' }))).toEqual({ show: false, reason: 'watching' })
  })
})

describe('wantsAttention', () => {
  it('flashes and badges only for requests, only while away, only when switched on', () => {
    expect(wantsAttention(DEFAULT_NOTIFICATIONS, BACK)).toBe(true)
    expect(wantsAttention(DEFAULT_NOTIFICATIONS, FRONT)).toBe(false)
    expect(wantsAttention(settings({ needsMe: false }), BACK)).toBe(false)
    expect(wantsAttention(settings({ enabled: false }), BACK)).toBe(false)
    expect(wantsAttention(settings({ finished: false, failed: false }), BACK)).toBe(true)
  })

  it('does not depend on the background-only setting, which governs toasts', () => {
    expect(wantsAttention(settings({ onlyInBackground: false }), FRONT)).toBe(false)
  })
})
