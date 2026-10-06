import { release } from 'node:os'
import { app, shell } from 'electron'
import { IPC, type AppFolderKind, type AppInfo } from '@shared/ipc'
import { dataDir, logsDir } from '../paths'
import type { IpcContext } from './context'

/** The folders Settings can open. The window names one of these; it never supplies a path. */
const FOLDERS: Record<AppFolderKind, () => string> = { data: dataDir, logs: logsDir }

export function parseFolderKind(value: unknown): AppFolderKind {
  if (value === 'data' || value === 'logs') return value
  throw new Error('Unknown folder.')
}

/** Version, runtime and file locations, read from the running process. */
export function buildAppInfo(): AppInfo {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    dataDir: dataDir(),
    logsDir: logsDir()
  }
}

/** Opens the folder in the file manager. Resolves to an empty string on success, or to what went wrong. */
export async function openAppFolder(kind: AppFolderKind): Promise<string> {
  return shell.openPath(FOLDERS[kind]())
}

export function register(ctx: IpcContext): void {
  ctx.handle(IPC.appInfo, (): AppInfo => buildAppInfo())
  ctx.handle(IPC.openAppFolder, (kind?: unknown): Promise<string> => openAppFolder(parseFolderKind(kind)))
}
