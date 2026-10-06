import type { ChatEvent } from '@shared/ipc'
import type { NotificationSettings } from '@shared/settings'
import { approvalBody, editedPaths, failedBody, finishedBody, planBody, questionBody, toastTitle } from './copy'
import { PRIORITY, decideNotification, inBackground, wantsAttention, type NotificationKind, type WindowState } from './decide'

export interface Toast {
  title: string
  body: string
  silent: boolean
}

export interface ToastHandle {
  close: () => void
}

/** Everything the notifier needs from the desktop, so the rules can be tested without Electron. */
export interface NotifyHost {
  windowState: () => WindowState
  /** Undefined when the platform cannot show notifications. */
  show: (toast: Toast, onClick: () => void) => ToastHandle | undefined
  flash: (on: boolean) => void
  /** Number of sessions waiting on the person, on the taskbar button; 0 clears it. */
  badge: (count: number) => void
  showWindow: () => void
  openConversation: (conversationId: string) => void
}

interface NotifierDeps {
  host: NotifyHost
  settings: () => NotificationSettings
  titleOf: (conversationId: string) => string | undefined
}

/**
 * Wait this long before showing. A title saved a moment after the turn ends is picked up, and a
 * person who comes straight back to the window is not told about something they are already looking at.
 */
export const SETTLE_MS = 400

interface Turn {
  conversationId: string
  edited: Set<string>
  waiting: boolean
}

interface Pending {
  kind: NotificationKind
  body: string
  timer: ReturnType<typeof setTimeout>
}

interface Shown {
  at: number
  kind: NotificationKind
  handle: ToastHandle | undefined
}

/**
 * Turns the stream of chat events into desktop notifications, a taskbar flash and a badge. It watches
 * each turn: a permission, question or plan means the session is waiting on the person; a completed
 * stream means it finished; an error that is not a cancel means it failed.
 */
export class Notifier {
  private readonly turns = new Map<string, Turn>()
  /** Sessions that are waiting on the person right now. */
  private readonly waiting = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly shown = new Map<string, Shown>()
  private onScreen: string | null = null
  private badged = 0

  constructor(private readonly deps: NotifierDeps) {}

  setOnScreen(conversationId: string | null): void {
    this.onScreen = conversationId
    this.dismissWatched()
  }

  /** The window came to the front: the person is back, so the flash, the badge and the toast for what they see are done. */
  onWindowFocus(): void {
    this.deps.host.flash(false)
    this.setBadge(0)
    this.dismissWatched()
  }

  /** The window went away (blur, minimize or hide): sessions that still wait show on the taskbar button. */
  onWindowBlur(): void {
    this.syncBadge()
  }

  onChatEvent(event: ChatEvent): void {
    const conversationId = event.conversationId
    if (!conversationId) return
    let turn = this.turns.get(event.streamId)
    if (!turn) {
      turn = { conversationId, edited: new Set(), waiting: false }
      this.turns.set(event.streamId, turn)
    }
    switch (event.kind) {
      case 'permission':
        this.wait(turn, approvalBody(event.ask))
        return
      case 'question':
        this.wait(turn, questionBody(event.ask))
        return
      case 'plan':
        if (!event.ask.status || event.ask.status === 'pending') this.wait(turn, planBody(event.ask))
        else this.resume(turn)
        return
      case 'tool':
        // A call can only settle once any question it raised was answered.
        if (event.tool.phase === 'done' || event.tool.phase === 'error') this.resume(turn)
        for (const path of editedPaths(event.tool)) turn.edited.add(path)
        return
      case 'stream':
        this.onStream(event.streamId, turn, event.event)
        return
      case 'iteration':
      case 'mode':
      case 'gateway':
      case 'compacted':
        this.resume(turn)
        return
      default:
        // Checklists, context readings, review revisions and background task updates can arrive while a session waits.
        return
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    for (const shown of this.shown.values()) shown.handle?.close()
    this.shown.clear()
    this.turns.clear()
    this.waiting.clear()
    this.deps.host.flash(false)
    this.setBadge(0)
  }

  private onStream(streamId: string, turn: Turn, event: Extract<ChatEvent, { kind: 'stream' }>['event']): void {
    if (event.type === 'completed') {
      this.endTurn(streamId, turn)
      // Pressing Stop is the person's own doing, and nobody needs telling.
      if (event.response.stopReason !== 'cancelled') this.enqueue(turn.conversationId, 'finished', finishedBody(turn.edited.size))
    } else if (event.type === 'error') {
      this.endTurn(streamId, turn)
      if (event.error.category !== 'CANCELLED') this.enqueue(turn.conversationId, 'failed', failedBody(event.error))
    } else {
      this.resume(turn)
    }
  }

  private endTurn(streamId: string, turn: Turn): void {
    this.turns.delete(streamId)
    this.resume(turn)
  }

  private wait(turn: Turn, body: string): void {
    turn.waiting = true
    this.waiting.add(turn.conversationId)
    if (wantsAttention(this.deps.settings(), this.deps.host.windowState())) this.deps.host.flash(true)
    this.syncBadge()
    this.enqueue(turn.conversationId, 'needsMe', body)
  }

  private resume(turn: Turn): void {
    if (!turn.waiting) return
    turn.waiting = false
    this.waiting.delete(turn.conversationId)
    const pending = this.pending.get(turn.conversationId)
    if (pending?.kind === 'needsMe') {
      clearTimeout(pending.timer)
      this.pending.delete(turn.conversationId)
    }
    // An approval answered in the app leaves nothing to act on in the notification center.
    const shown = this.shown.get(turn.conversationId)
    if (shown?.kind === 'needsMe' && shown.handle) {
      shown.handle.close()
      shown.handle = undefined
    }
    this.syncBadge()
    if (this.waiting.size === 0) this.deps.host.flash(false)
  }

  private syncBadge(): void {
    this.setBadge(wantsAttention(this.deps.settings(), this.deps.host.windowState()) ? this.waiting.size : 0)
  }

  private setBadge(count: number): void {
    if (count === this.badged) return
    this.badged = count
    this.deps.host.badge(count)
  }

  /** The toast of the session the person is looking at is stale as soon as they are looking at it. */
  private dismissWatched(): void {
    if (!this.onScreen || inBackground(this.deps.host.windowState())) return
    const shown = this.shown.get(this.onScreen)
    if (!shown?.handle) return
    shown.handle.close()
    shown.handle = undefined
  }

  private enqueue(conversationId: string, kind: NotificationKind, body: string, delay = SETTLE_MS): void {
    const existing = this.pending.get(conversationId)
    // Something more urgent for this session is already on its way.
    if (existing && PRIORITY[existing.kind] > PRIORITY[kind]) return
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => this.deliver(conversationId), delay)
    this.pending.set(conversationId, { kind, body, timer })
  }

  private deliver(conversationId: string): void {
    const pending = this.pending.get(conversationId)
    if (!pending) return
    this.pending.delete(conversationId)
    // A request for the person is only worth showing while it still waits.
    if (pending.kind === 'needsMe' && !this.waiting.has(conversationId)) return
    const settings = this.deps.settings()
    const previous = this.shown.get(conversationId)
    const now = Date.now()
    const decision = decideNotification({
      kind: pending.kind,
      conversationId,
      settings,
      window: this.deps.host.windowState(),
      onScreen: this.onScreen,
      lastShownAt: previous?.at,
      now
    })
    if (!decision.show) {
      // A stalled session must not stay unannounced because a toast went out a moment ago: it follows when the limit ends.
      if (decision.reason === 'throttled' && pending.kind === 'needsMe' && decision.retryAt !== undefined) {
        this.enqueue(conversationId, 'needsMe', pending.body, Math.max(0, decision.retryAt - now))
      }
      return
    }
    // One toast per session in the notification center: the new one replaces the old.
    previous?.handle?.close()
    let title: string | undefined
    try { title = this.deps.titleOf(conversationId) } catch { title = undefined }
    const handle = this.deps.host.show({ title: toastTitle(title), body: pending.body, silent: !settings.sound }, () => {
      this.deps.host.showWindow()
      this.deps.host.openConversation(conversationId)
    })
    this.shown.set(conversationId, { at: now, kind: pending.kind, handle })
  }
}
