import { IPC } from '@shared/ipc'
import type { IpcContext } from './context'
import { findWorkspaceFiles, listWorkspaceDir, parseBrowseOptions, parseReadOptions, readWorkspaceFile, statWorkspacePaths } from '../workspaceRead'

/**
 * Files tab handlers. Everything the renderer sends is untrusted: `taskWorkspace` validates the task id
 * and picks that task's own folder, and the readers validate each path against it (symlinks included).
 */
export function register(ctx: IpcContext): void {
  ctx.handle(IPC.readWorkspaceFile, (relPath: unknown, conversationId?: unknown, options?: unknown) =>
    readWorkspaceFile(ctx.taskWorkspace(conversationId as string | undefined), relPath, parseReadOptions(options)))
  ctx.handle(IPC.listWorkspaceDir, (relPath: unknown, conversationId?: unknown, options?: unknown) =>
    listWorkspaceDir(ctx.taskWorkspace(conversationId as string | undefined), relPath, parseBrowseOptions(options)))
  ctx.handle(IPC.findWorkspaceFiles, (query: unknown, limit?: unknown, conversationId?: unknown, options?: unknown) =>
    findWorkspaceFiles(ctx.taskWorkspace(conversationId as string | undefined), query, limit, parseBrowseOptions(options)))
  ctx.handle(IPC.statWorkspacePaths, (paths: unknown, conversationId?: unknown) =>
    statWorkspacePaths(ctx.taskWorkspace(conversationId as string | undefined), paths))
}
