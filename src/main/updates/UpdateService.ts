import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadError, discardPartial, downloadFile, type FileProgress } from '@local/download'
import type { UpdateBusy, UpdateInstallRequest, UpdateInstallResult, UpdateState } from '@shared/updates'
import { isNewerVersion, normalizeVersion } from '@shared/version'
import type { ReleaseFeed } from './feed'
import type { InstallSupport } from './installer'
import { fetchLatestRelease, type ParsedRelease, type ReleaseInstaller } from './releases'

/** The first look comes a little after start, so it never competes with the window opening. */
export const FIRST_CHECK_DELAY_MS = 20_000
/** Then about four times a day while Cubex stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const LOCAL_ONLY_MESSAGE = 'Local-only mode blocks update checks. Turn it off in Privacy to check.'
export const LOCAL_ONLY_DOWNLOAD_MESSAGE = 'Local-only mode blocks the download. Turn it off in Privacy to download the update.'

const PROGRESS_INTERVAL_MS = 100
const MAX_REDIRECTS = 5
/** The installer is 85 MB; this much must stay free besides it. */
const RESERVE_BYTES = 200 * 1024 * 1024
const INSTALLER_FILE = /^Cubex-Setup-.+\.exe(?:\.part(?:\.json)?)?$/
/** The same names, with the version they are for. */
const INSTALLER_VERSION = /^Cubex-Setup-(.+?)\.exe(?:\.part(?:\.json)?)?$/

export interface UpdateServiceOptions {
  currentVersion: string
  support: InstallSupport
  feed: ReleaseFeed
  fetch: typeof fetch
  userAgent: string
  /** The folder installers are downloaded to. */
  directory: string
  /** Look for updates on its own. False for a copy run from source. */
  automatic: boolean
  /** Read on every use, so a change in Settings counts at once. */
  settings: () => { auto: boolean; skippedVersion?: string; localOnly: boolean }
  /** Remember the version the person skipped. An empty string forgets it. */
  saveSkippedVersion: (version: string) => void
  /** Tell the window the state changed. */
  push: (state: UpdateState) => void
  /** What is still working. Restarting would stop it. */
  busy: () => UpdateBusy
  startInstaller: (path: string) => Promise<void>
  quit: () => void
  openExternal: (url: string) => Promise<void>
  now?: () => number
  firstCheckDelayMs?: number
  intervalMs?: number
  /** Tuning of the download for tests. */
  download?: { retryDelayMs?: (attempt: number) => number; stallTimeoutMs?: number; reserveBytes?: number }
  log?: (level: 'info' | 'warn', message: string, details?: Record<string, unknown>) => void
}

type Update = NonNullable<UpdateState['update']>

/** The address a request is for, whatever form it was given in. */
function addressOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/**
 * A fetch that follows redirects itself, one hop at a time, and only to hosts the feed allows. GitHub answers a
 * release download with a redirect to its file servers; a redirect anywhere else is refused before it is requested.
 */
export function followAllowedRedirects(base: typeof fetch, feed: ReleaseFeed): typeof fetch {
  return async (input, init) => {
    let address = addressOf(input)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = new URL(address)
      const secure = url.protocol === 'https:' || (feed.local && url.protocol === 'http:')
      if (!secure || !feed.allowsHost(url.host)) throw new Error(`The download was sent to ${url.host}, ${REFUSED_HOST}.`)
      const response = await base(url.href, { ...init, redirect: 'manual' })
      const next = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && next) {
        await response.body?.cancel().catch(() => undefined)
        address = new URL(next, url).href
        continue
      }
      return response
    }
    throw new Error('The download was redirected too many times.')
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Part of the error `followAllowedRedirects` throws. The download library wraps it, so the sentence is found by its words. */
const REFUSED_HOST = 'which Cubex does not use for updates'

/** What went wrong with a download, said for the person. The download library's own words are about models. */
export function describeDownloadFailure(error: unknown): string {
  if (error instanceof Error && error.message.includes(REFUSED_HOST)) {
    return 'GitHub sent the download to a server Cubex does not use for updates, so it stopped. Download the installer from the release page.'
  }
  switch (error instanceof DownloadError ? error.code : undefined) {
    case 'disk_space': return 'There is not enough free disk space for the update. Free some space and try again.'
    case 'checksum': return 'The downloaded file did not match its checksum, so Cubex deleted it. Try again, or download the installer from the release page.'
    case 'http': return 'GitHub did not provide the installer. Try again later, or download it from the release page.'
    case 'incomplete':
    case 'network':
    case 'stalled': return 'The download stopped before it finished. Check your connection and try again.'
    case 'write':
    case 'unsafe_path': return 'Cubex could not save the installer on this computer. Check that its data folder can be written to, then try again.'
    default: return 'The download failed. Try again, or download the installer from the release page.'
  }
}

/**
 * Finds out whether a newer Cubex was released, downloads and checks its installer when the person asks, and hands it
 * to the installer program. It owns the state the window shows and pushes every change; the window only asks for the
 * next step. All outside effects arrive as options, so nothing here needs Electron, a network or a real clock.
 */
export class UpdateService {
  private check: UpdateState['check'] = { status: 'idle' }
  private lastChecked: number | undefined
  private update: Update | undefined
  /** The newest release as parsed: the address and checksum the window never sees. */
  private release: ParsedRelease | undefined
  /** The installer that was downloaded and verified. */
  private readyPath: string | undefined
  private checking: Promise<UpdateState> | undefined
  private checkController: AbortController | undefined
  private downloading: { controller: AbortController; job: Promise<void>; byPerson: boolean } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private disposed = false
  private lastProgressAt = 0

  constructor(private readonly options: UpdateServiceOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private log(level: 'info' | 'warn', message: string, details?: Record<string, unknown>): void {
    this.options.log?.(level, message, details)
  }

  getState(): UpdateState {
    const { support } = this.options
    return {
      currentVersion: this.options.currentVersion,
      canInstall: support.canInstall,
      ...(!support.canInstall && support.reason ? { cannotInstallReason: support.reason } : {}),
      check: { ...this.check },
      ...(this.update ? { update: { ...this.update, ...(this.update.progress ? { progress: { ...this.update.progress } } : {}) } } : {})
    }
  }

  private emit(): void {
    if (this.disposed) return
    // A window that is gone or slow must not break a check or a download.
    try { this.options.push(this.getState()) } catch { /* the next change pushes again */ }
  }

  /** Begins the checks of a running Cubex. A second call does nothing. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.removeUsedInstallers()
    this.schedule(this.options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS)
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.automaticCheck().finally(() => {
        if (!this.disposed) this.schedule(this.options.intervalMs ?? CHECK_INTERVAL_MS)
      })
    }, delay)
    // A pending check must never keep Cubex from quitting.
    this.timer.unref?.()
  }

  /** A check nobody asked for. It stays quiet when the person switched it off, and after a failure it simply waits for the next time. */
  private async automaticCheck(): Promise<void> {
    const settings = this.options.settings()
    if (!this.options.automatic || !settings.auto || settings.localOnly) return
    await this.runCheck(false)
  }

  /** Looks at the latest release. Resolves with the state once the answer is in. */
  checkNow(manual: boolean): Promise<UpdateState> {
    return this.runCheck(manual)
  }

  private runCheck(manual: boolean): Promise<UpdateState> {
    if (this.checking) return this.checking
    const stage = this.update?.stage
    if (this.disposed || stage === 'downloading' || stage === 'installing') return Promise.resolve(this.getState())
    const settings = this.options.settings()
    if (settings.localOnly) {
      if (manual) {
        this.check = { ...this.check, status: 'failed', error: LOCAL_ONLY_MESSAGE }
        this.emit()
      }
      return Promise.resolve(this.getState())
    }
    const job = this.lookUp(manual, settings.skippedVersion).finally(() => { this.checking = undefined })
    this.checking = job
    return job
  }

  private async lookUp(manual: boolean, skipped: string | undefined): Promise<UpdateState> {
    this.check = { status: 'checking', ...(this.lastChecked !== undefined ? { at: this.lastChecked } : {}) }
    this.emit()
    const controller = new AbortController()
    this.checkController = controller
    const result = await fetchLatestRelease({ fetch: this.options.fetch, feed: this.options.feed, userAgent: this.options.userAgent, signal: controller.signal })
    this.checkController = undefined
    if (this.disposed) return this.getState()

    if (!result.ok) {
      this.log('warn', 'Update check failed', { manual, error: result.error })
      this.check = { status: 'failed', error: result.error, ...(this.lastChecked !== undefined ? { at: this.lastChecked } : {}) }
      this.emit()
      return this.getState()
    }

    const at = this.now()
    this.lastChecked = at
    this.check = { status: 'done', at }
    // A download in progress is not interrupted by what a late check found; the next check sees it.
    if (!this.downloading) this.adopt(result.release, manual, skipped)
    this.log('info', 'Update check finished', { manual, latest: result.release.info.version, newer: !!this.update })
    this.emit()
    return this.getState()
  }

  /** Takes a release as the one to offer, if it is newer than this copy. */
  private adopt(release: ParsedRelease, manual: boolean, skipped: string | undefined): void {
    const { info } = release
    if (!isNewerVersion(info.version, this.options.currentVersion)) {
      this.update = undefined
      this.release = undefined
      this.readyPath = undefined
      return
    }
    this.release = release
    const known = this.update?.info.version === info.version ? this.update : undefined
    if (!known) this.readyPath = undefined
    // Asking by hand answers a skip: the person wants to see what is there.
    const isSkipped = !manual && info.version === skipped
    if (manual && info.version === skipped) this.options.saveSkippedVersion('')
    this.update = {
      info,
      stage: known?.stage ?? 'available',
      ...(isSkipped ? { skipped: true } : {}),
      ...(known?.progress ? { progress: known.progress } : {}),
      ...(known?.error ? { error: known.error } : {})
    }
  }

  /** Downloads and verifies the installer of the update on offer. Resolves when that is over; the state says how it went. */
  download(): Promise<UpdateState> {
    const update = this.update
    if (this.disposed || !update || update.stage !== 'available' || this.downloading) return Promise.resolve(this.getState())
    const refuse = (message: string): Promise<UpdateState> => {
      this.update = { ...update, error: message }
      this.emit()
      return Promise.resolve(this.getState())
    }
    if (this.options.settings().localOnly) return refuse(LOCAL_ONLY_DOWNLOAD_MESSAGE)
    if (!this.options.support.canInstall) return refuse(this.options.support.reason ?? 'This copy cannot update itself.')
    const installer = this.release?.info.version === update.info.version ? this.release.installer : undefined
    if (!installer) return refuse(update.info.installerProblem ?? 'This release has no installer Cubex can use.')

    const controller = new AbortController()
    this.update = { info: update.info, stage: 'downloading', progress: { received: 0, total: installer.size }, ...(update.skipped ? { skipped: true } : {}) }
    this.lastProgressAt = 0
    this.emit()
    const job = this.fetchInstaller(update, installer, controller)
    this.downloading = { controller, job, byPerson: false }
    return job.then(() => this.getState())
  }

  private async fetchInstaller(update: Update, installer: ReleaseInstaller, controller: AbortController): Promise<void> {
    const { directory } = this.options
    const destination = join(directory, installer.name)
    const tuning = this.options.download ?? {}
    const remember = (extra: Partial<Update>): void => {
      this.update = { info: update.info, stage: 'available', ...(update.skipped ? { skipped: true } : {}), ...extra }
    }
    try {
      await mkdir(directory, { recursive: true })
      await this.removeOtherInstallers(installer.name)
      const result = await downloadFile({
        url: installer.url,
        destPath: destination,
        rootDir: directory,
        expectedSize: installer.size,
        expectedSha256: installer.sha256,
        fetch: followAllowedRedirects(this.options.fetch, this.options.feed),
        headers: { 'User-Agent': this.options.userAgent },
        signal: controller.signal,
        // A quit in the middle keeps what arrived, so the next download goes on from there. Cancel deletes it below.
        keepPartialOnCancel: true,
        maxAttempts: 3,
        retryDelayMs: tuning.retryDelayMs ?? ((attempt) => 1500 * attempt),
        stallTimeoutMs: tuning.stallTimeoutMs ?? 30_000,
        reserveBytes: tuning.reserveBytes ?? RESERVE_BYTES,
        onProgress: (progress) => this.report(progress)
      })
      if (this.disposed) return
      // A checksum was given, so an unverified result would mean the library skipped it. Never run such a file.
      if (!result.verified) throw new DownloadError('checksum', 'The installer was not verified.')
      this.readyPath = result.path
      this.update = { info: update.info, stage: 'ready', ...(update.skipped ? { skipped: true } : {}) }
      this.log('info', 'Update downloaded', { version: update.info.version, bytes: result.bytes, alreadyPresent: result.alreadyPresent })
    } catch (error) {
      if (this.disposed) return
      if (error instanceof DownloadError && error.code === 'cancelled') {
        if (this.downloading?.byPerson) await discardPartial(destination)
        remember({})
      } else {
        // The download library's own sentences are about models and Hugging Face, so a failure it raised is logged by its code.
        this.log('warn', 'Update download failed', error instanceof DownloadError
          ? { version: update.info.version, code: error.code }
          : { version: update.info.version, code: 'other', reason: error instanceof Error ? error.message : String(error) })
        remember({ error: describeDownloadFailure(error) })
      }
    } finally {
      this.downloading = undefined
      this.emit()
    }
  }

  /** Progress arrives for every chunk; the window gets it ten times a second at most, and always the last. */
  private report(progress: FileProgress): void {
    const update = this.update
    if (!update || update.stage !== 'downloading') return
    const total = progress.totalBytes ?? update.progress?.total ?? 0
    // Checking the file after it arrived is shown as complete.
    const received = Math.min(progress.phase === 'downloading' ? progress.completedBytes : total, total)
    const at = this.now()
    if (received < total && at - this.lastProgressAt < PROGRESS_INTERVAL_MS) return
    this.lastProgressAt = at
    this.update = { ...update, progress: { received, total } }
    this.emit()
  }

  /**
   * An installer for this version or an older one has done its work: the copy that is running is the version it set up.
   * It is deleted, so an update does not leave a hundred megabytes in the data folder. A newer one stays, because it is
   * a download that is waiting for its restart.
   */
  private async removeUsedInstallers(): Promise<void> {
    const names = await readdir(this.options.directory).catch(() => [] as string[])
    for (const name of names) {
      const found = INSTALLER_VERSION.exec(name)
      const version = found ? normalizeVersion(found[1]) : undefined
      if (!version || isNewerVersion(version, this.options.currentVersion)) continue
      await rm(join(this.options.directory, name), { force: true }).catch(() => undefined)
    }
  }

  /** Earlier versions' installers are of no use any more. */
  private async removeOtherInstallers(keep: string): Promise<void> {
    const names = await readdir(this.options.directory).catch(() => [] as string[])
    for (const name of names) {
      if (!INSTALLER_FILE.test(name) || name === keep || name === `${keep}.part` || name === `${keep}.part.json`) continue
      await rm(join(this.options.directory, name), { force: true }).catch(() => undefined)
    }
  }

  /** Stops a download the person started and deletes what arrived. */
  cancelDownload(): Promise<UpdateState> {
    const running = this.downloading
    if (!running) return Promise.resolve(this.getState())
    running.byPerson = true
    running.controller.abort()
    return running.job.then(() => this.getState())
  }

  /** Runs the downloaded installer and quits, unless work is running and the person has not said to stop it. */
  async install(request: UpdateInstallRequest = {}): Promise<UpdateInstallResult> {
    const update = this.update
    const path = this.readyPath
    const installer = this.release?.installer
    if (this.disposed || !update || update.stage !== 'ready' || !path || !installer || this.release?.info.version !== update.info.version) {
      return { ok: false, reason: 'failed', message: 'There is no downloaded update to install. Download it first.' }
    }
    const busy = this.options.busy()
    if ((busy.turns > 0 || busy.tasks > 0) && !request.force) return { ok: false, reason: 'busy', busy }

    // The file sat on disk since it was checked. Check it again right before it runs.
    const problem = await this.recheck(path, installer)
    if (problem) {
      this.readyPath = undefined
      this.update = { info: update.info, stage: 'available', ...(update.skipped ? { skipped: true } : {}), error: problem }
      this.emit()
      return { ok: false, reason: 'failed', message: problem }
    }

    this.update = { info: update.info, stage: 'installing', ...(update.skipped ? { skipped: true } : {}) }
    this.emit()
    try {
      await this.options.startInstaller(path)
    } catch (error) {
      const message = `Cubex could not start the installer${error instanceof Error && error.message ? ` (${error.message})` : ''}. Open ${path} yourself to finish.`
      this.log('warn', 'Update installer did not start', { reason: error instanceof Error ? error.message : String(error) })
      this.update = { info: update.info, stage: 'ready', ...(update.skipped ? { skipped: true } : {}), error: message }
      this.emit()
      return { ok: false, reason: 'failed', message }
    }
    this.log('info', 'Update installer started', { version: update.info.version })
    this.options.quit()
    return { ok: true }
  }

  /** Why the file at `path` can no longer be trusted, or undefined when it still is what was downloaded. */
  private async recheck(path: string, installer: ReleaseInstaller): Promise<string | undefined> {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size !== installer.size) throw new Error('size')
      if ((await sha256Of(path)) !== installer.sha256) throw new Error('checksum')
      return undefined
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined)
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return missing
        ? 'The downloaded installer is no longer there. Download it again.'
        : 'The downloaded installer changed after it was checked, so Cubex deleted it. Download it again.'
    }
  }

  /** The person does not want this version: it is not announced again, and a newer one is. */
  skip(version: string): UpdateState {
    const wanted = normalizeVersion(version)
    const update = this.update
    if (!update || !wanted || update.info.version !== wanted || update.stage === 'downloading' || update.stage === 'installing') return this.getState()
    this.options.saveSkippedVersion(wanted)
    this.update = { ...update, skipped: true }
    this.emit()
    return this.getState()
  }

  /** Opens the page of the release on offer, or the list of releases. The address is the one the release parsed to, never one the window gave. */
  async openReleasePage(): Promise<void> {
    await this.options.openExternal(this.update?.info.pageUrl ?? this.options.feed.releasesUrl)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.checkController?.abort()
    this.downloading?.controller.abort()
  }
}
