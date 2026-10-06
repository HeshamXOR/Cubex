import type { BrowserWindow } from 'electron'
import type { ChatEvent } from '@shared/ipc'
import type { ChatService } from '../ChatService'
import type { LocalService } from '../LocalService'
import type { ProviderManager } from '../ProviderManager'

/** What a handler module gets from the main process. Built once in registerIpc. */
export interface IpcContext {
  /** Register a handler for an invoke channel from `IPC`. The renderer's arguments arrive untrusted: validate them. */
  handle: <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void
  /** Push an event to the renderer window; does nothing once the window is gone. */
  send: (channel: string, payload: unknown) => void
  /** Observe every chat event the window receives, in the main process. Returns the unsubscribe function. */
  onChatEvent: (listener: (event: ChatEvent) => void) => () => void
  getWindow: () => BrowserWindow | null
  chat: ChatService
  local: LocalService
  providers: ProviderManager
  /** A renderer-supplied task (conversation) id: returns it, or throws when it is not a bounded string. */
  taskIdArg: (value: unknown) => string
  /** The workspace folder a task works in (the selected folder when no id is given); undefined when there is none. */
  taskWorkspace: (conversationId?: string) => string | undefined
}

/**
 * A file in `src/main/ipcModules/` that exports `register`. It is picked up by `registerIpcModules`,
 * so adding a feature's handlers never means editing `ipc.ts`. Return a function to clean up on quit.
 */
export interface IpcModule {
  register: (ctx: IpcContext) => void | (() => void)
}
