import { IPC } from '@shared/ipc'
import { conversationRepo } from '../db'
import { RestoreCoordinator, parseMessageId, parseRestoreAxes, parseUndoId } from '../restoreCoordinator'
import type { IpcContext } from './context'

/**
 * Going back to an earlier message (`restoreCheckpoint`), seeing what that would change (`previewRestore`) and
 * taking it back (`undoRestore`). Renderer arguments are untrusted: ids are bounded strings, the axes two booleans.
 */
export function register(ctx: IpcContext): void {
  // Built on first use: it needs the ChatService stores, and registering may only declare handlers.
  let coordinator: RestoreCoordinator | undefined
  const restore = (): RestoreCoordinator => (coordinator ??= new RestoreCoordinator(ctx.chat.restoreHost(), conversationRepo))

  ctx.handle(IPC.restoreCheckpoint, (conversationId: unknown, messageId: unknown, axes: unknown) =>
    restore().restore(ctx.taskIdArg(conversationId), parseMessageId(messageId), parseRestoreAxes(axes)))
  ctx.handle(IPC.restorePreview, (conversationId: unknown, messageId: unknown) =>
    restore().preview(ctx.taskIdArg(conversationId), parseMessageId(messageId)))
  ctx.handle(IPC.restoreUndo, (conversationId: unknown, undoId: unknown) =>
    restore().undo(ctx.taskIdArg(conversationId), parseUndoId(undoId)))
}
