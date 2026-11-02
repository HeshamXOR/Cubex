import { powerSaveBlocker } from 'electron'
import { getSettings } from '../config'
import { PowerKeeper } from '../power/PowerKeeper'
import type { IpcContext } from './context'

/** Keeps the computer awake while a reply is generating, a goal is being checked or a background task is running, unless the person turned it off. */
export function register(ctx: IpcContext): () => void {
  const keeper = new PowerKeeper({
    // Reached only when a hold is taken or released: registering never touches Electron's power module.
    blocker: { start: (type) => powerSaveBlocker.start(type), stop: (id) => powerSaveBlocker.stop(id) },
    // Looked up when asked, never at registration: the chat service is only used from the first look onward.
    busy: () => ctx.chat.runningTurns > 0 || ctx.chat.runningGoalChecks > 0 || ctx.chat.processManager.list().some((task) => task.status === 'running'),
    enabled: () => getSettings().general.keepAwake !== false
  })
  keeper.start()
  return () => keeper.dispose()
}
