import { IPC } from '@shared/ipc'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '@shared/settings'
import { conversationRepo } from '../db'
import { getSettings } from '../config'
import { createElectronHost } from '../notifications/electronHost'
import { Notifier } from '../notifications/Notifier'
import type { IpcContext } from './context'

const notificationSettings = (): NotificationSettings => ({ ...DEFAULT_NOTIFICATIONS, ...getSettings().notifications })

/** The renderer reports the session on screen, or null when no session is shown. */
function parseActiveConversation(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid task id.')
  return value
}

/**
 * Desktop notifications: a toast when a session needs the person, finishes or fails while they are
 * elsewhere, plus the taskbar flash and badge. The rules live in notifications/; this wires them to
 * the window and the chat event stream.
 */
export function register(ctx: IpcContext): () => void {
  // Window events reach the notifier through the host, which is built first; the closures run later.
  const host = createElectronHost({
    getWindow: ctx.getWindow,
    send: ctx.send,
    onFocus: () => notifier.onWindowFocus(),
    onBlur: () => notifier.onWindowBlur()
  })
  const notifier = new Notifier({
    host,
    settings: notificationSettings,
    titleOf: (conversationId) => conversationRepo.listSummaries().find((summary) => summary.id === conversationId)?.title
  })

  const stopListening = ctx.onChatEvent((event) => notifier.onChatEvent(event))
  ctx.handle(IPC.notifyActiveConversation, (conversationId: unknown) => {
    notifier.setOnScreen(parseActiveConversation(conversationId))
  })
  // Ignores every rule on purpose: the person asked, and the point is to see whether the system lets it through.
  ctx.handle(IPC.notifyTest, (): { shown: boolean; reason?: string } => {
    const handle = host.show(
      { title: 'Cubex', body: 'Notifications are on. Cubex will say here when a session needs you.', silent: !notificationSettings().sound },
      () => host.showWindow()
    )
    return handle ? { shown: true } : { shown: false, reason: 'This system does not allow Cubex to show desktop notifications.' }
  })

  return () => {
    stopListening()
    notifier.dispose()
  }
}
