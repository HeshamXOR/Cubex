import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { UpdateBusy, UpdateInstallRequest, UpdateInstallResult, UpdateState } from '@shared/updates'
import { normalizeVersion } from '@shared/version'
import { getSettings, updateSettings } from '../config'
import { logger } from '../logger'
import { dataDir } from '../paths'
import { resolveFeed } from '../updates/feed'
import { installSupport, startInstaller } from '../updates/installer'
import { UpdateService } from '../updates/UpdateService'
import type { IpcContext } from './context'

/** The window's request to restart: anything but `{ force: true }` asks first when work is running. */
export function parseInstallRequest(value: unknown): UpdateInstallRequest {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update request.')
  return { force: (value as { force?: unknown }).force === true }
}

/** The version the window wants to skip. It names a release that was offered; it is never an address. */
export function parseSkippedVersion(value: unknown): string {
  const version = normalizeVersion(value)
  if (!version) throw new Error('That is not a version number.')
  return version
}

export function register(ctx: IpcContext): () => void {
  // Nothing is built until the window first asks, so registering stays free of Electron's app object and timers.
  let service: UpdateService | undefined
  const current = (): UpdateService => {
    if (service) return service
    const feed = resolveFeed(process.env.CUBEX_UPDATE_FEED)
    const version = app.getVersion()
    service = new UpdateService({
      currentVersion: version,
      support: installSupport({ platform: process.platform, packaged: app.isPackaged, execPath: process.execPath }, existsSync),
      feed,
      fetch: (input, init) => fetch(input, init),
      userAgent: `Cubex/${version}`,
      directory: join(dataDir(), 'updates'),
      // A copy run from source has no release to be compared with, unless a local feed was asked for.
      automatic: app.isPackaged || feed.local,
      settings: () => {
        const settings = getSettings()
        return { auto: settings.updates?.auto ?? true, skippedVersion: settings.updates?.skippedVersion, localOnly: settings.privacy.localOnly }
      },
      saveSkippedVersion: (skipped) => { updateSettings({ updates: { auto: getSettings().updates?.auto ?? true, skippedVersion: skipped } }) },
      push: (state: UpdateState) => ctx.send(IPC.updatesState, state),
      busy: (): UpdateBusy => ({
        turns: ctx.chat.runningTurns,
        tasks: ctx.chat.processManager.list().filter((task) => task.status === 'running').length
      }),
      startInstaller,
      quit: () => app.quit(),
      openExternal: (url) => shell.openExternal(url),
      log: (level, message, details) => {
        const text = details ? `${message} (${Object.entries(details).map(([key, value]) => `${key} ${String(value)}`).join(', ')})` : message
        if (level === 'warn') logger.warn(text)
        else logger.info(text)
      }
    })
    return service
  }

  ctx.handle(IPC.updatesGet, (): UpdateState => {
    const updates = current()
    updates.start()
    return updates.getState()
  })
  ctx.handle(IPC.updatesCheck, (): Promise<UpdateState> => current().checkNow(true))
  // The download takes minutes; the window follows it through pushed state, so this answers as soon as it has begun.
  ctx.handle(IPC.updatesDownload, (): UpdateState => {
    const updates = current()
    void updates.download()
    return updates.getState()
  })
  ctx.handle(IPC.updatesCancel, (): Promise<UpdateState> => current().cancelDownload())
  ctx.handle(IPC.updatesInstall, (request?: unknown): Promise<UpdateInstallResult> => current().install(parseInstallRequest(request)))
  ctx.handle(IPC.updatesSkip, (version?: unknown): UpdateState => current().skip(parseSkippedVersion(version)))
  ctx.handle(IPC.updatesOpenPage, (): Promise<void> => current().openReleasePage())

  return () => service?.dispose()
}
