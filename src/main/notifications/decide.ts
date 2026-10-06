import type { NotificationSettings } from '@shared/settings'

export type NotificationKind = 'needsMe' | 'finished' | 'failed'

/** A session gets at most one notification in this long. */
export const THROTTLE_MS = 5_000

/** Worth showing first: a stalled session beats a failed one, which beats a finished one. */
export const PRIORITY: Record<NotificationKind, number> = { needsMe: 3, failed: 2, finished: 1 }

export interface WindowState {
  focused: boolean
  minimized: boolean
  /** False while the window is hidden, for example closed to the tray. */
  visible: boolean
}

/** The window is not what the person is looking at. */
export const inBackground = (window: WindowState): boolean => !window.focused || window.minimized || !window.visible

export interface DecisionInput {
  kind: NotificationKind
  conversationId: string
  settings: NotificationSettings
  window: WindowState
  /** The session the window shows right now; null when it shows none, for example while Settings is open. */
  onScreen: string | null
  /** When this session last had a notification shown. */
  lastShownAt: number | undefined
  now: number
}

type SkipReason = 'disabled' | 'type-off' | 'watching' | 'foreground' | 'throttled'

type Decision =
  | { show: true }
  | { show: false; reason: SkipReason; /** Set when the only thing in the way is the rate limit: the time it ends. */ retryAt?: number }

/**
 * Whether a notification is worth showing. The window being in front on that very session means the
 * person is watching it, so nothing is said. In front on another session, it is still quiet unless
 * "only when in the background" is off. A session that was just notified about waits out the throttle.
 */
export function decideNotification(input: DecisionInput): Decision {
  const { settings, kind } = input
  if (!settings.enabled) return { show: false, reason: 'disabled' }
  if (!settings[kind]) return { show: false, reason: 'type-off' }
  if (!inBackground(input.window)) {
    if (input.onScreen === input.conversationId) return { show: false, reason: 'watching' }
    if (settings.onlyInBackground) return { show: false, reason: 'foreground' }
  }
  if (input.lastShownAt !== undefined && input.now - input.lastShownAt < THROTTLE_MS) {
    return { show: false, reason: 'throttled', retryAt: input.lastShownAt + THROTTLE_MS }
  }
  return { show: true }
}

/** The taskbar flash and badge are for sessions that need the person, and only while they are elsewhere. */
export function wantsAttention(settings: NotificationSettings, window: WindowState): boolean {
  return settings.enabled && settings.needsMe && inBackground(window)
}
