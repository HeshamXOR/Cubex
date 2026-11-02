import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '@shared/settings'
import { THROTTLE_MS, decideNotification, type DecisionInput, type WindowState } from './decide'

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
})

describe('decideNotification focus and session', () => {
  it('stays quiet about the session the person is looking at', () => {
    for (const kind of ['needsMe', 'finished', 'failed'] as const) {
      expect(decideNotification(input({ kind, window: FRONT, onScreen: 'a' }))).toEqual({ show: false, reason: 'watching' })
      expect(decideNotification(input({ kind, window: FRONT, onScreen: 'a', settings: settings({ onlyInBackground: false }) }))).toEqual({ show: false, reason: 'watching' })
    }
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
})
