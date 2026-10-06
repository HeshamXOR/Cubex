import { IPC } from '@shared/ipc'
import type { IpcContext } from './context'

/** Provider model lists. Renderer input is untrusted: the id is a bounded string, and an unknown one is simply "turned off". */
export function register(ctx: IpcContext): void {
  ctx.handle(IPC.refreshModels, (providerId: unknown) => {
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 128) throw new Error('Invalid provider id.')
    return ctx.providers.refreshModels(providerId)
  })
}
