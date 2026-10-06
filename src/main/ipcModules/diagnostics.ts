import { resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import { getSettings } from '../config'
import { createDiagnosticsHandlers } from '../diagnostics/handlers'
import { disposeSharedDiagnostics, sharedDiagnostics } from '../diagnostics/service'
import { resolveWorkspacePath } from '../workspaceFiles'
import type { IpcContext } from './context'

/** A path inside the workspace as an absolute path; undefined when the file is not there. Escapes throw. */
function insideWorkspace(workspace: string, path: string): string | undefined {
  try {
    resolveWorkspacePath(workspace, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // The checker is given the lexical path under the workspace as the task spells it; the real path was only checked.
  return resolve(workspace, path)
}

/** Current compiler problems and whether the checker can run, for the Problems list and the Settings status line. */
export function register(ctx: IpcContext): () => void {
  const handlers = createDiagnosticsHandlers({
    taskId: ctx.taskIdArg,
    enabled: () => getSettings().diagnostics?.afterEdit === 'errors',
    workspaceOf: ctx.taskWorkspace,
    changedFiles: async (conversationId) =>
      (await ctx.chat.getSessionChanges(conversationId)).filter((file) => file.status !== 'deleted').map((file) => file.path),
    inWorkspace: insideWorkspace,
    manager: sharedDiagnostics
  })
  ctx.handle(IPC.diagnosticsGet, handlers.get)
  ctx.handle(IPC.diagnosticsStatus, handlers.status)
  // The checker's worker threads belong to the app, not to a window: they stop when the handlers do.
  return disposeSharedDiagnostics
}
