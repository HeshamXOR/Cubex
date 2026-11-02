import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, chmodSync } from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import type { AntigravityInstallPhase as InstallPhase, AntigravityInstallState as InstallState } from '@shared/antigravity'
import { antigravityInstallBytes, antigravityProgramNames, resolveAntigravityReleaseAsset, type AntigravityReleaseAsset } from './release'
import { ZipArchive, ZipError, isPlainFile } from './zip'

/**
 * Installing Google's Antigravity runtime for Cubex to use, and finding it again. The install is Google's own archive, from
 * Google's own host, only when the person asks. It is accepted only if it is exactly the release Cubex pins: the download has the
 * pinned size and SHA-256, the archive holds exactly the two programs with the pinned sizes, and the program starts and says it is
 * the release. Only then does an "active" file point at it, so an install that fails or is cancelled at any step leaves what was
 * there before as it was. Ported from the T3 Code project (github.com/pingdotgg/t3code, MIT licence, Copyright (c) 2026 T3 Tools
 * Inc.); see THIRD_PARTY_NOTICES.md.
 */

const DOWNLOAD_TIMEOUT_MS = 45 * 60_000
const RECORD_MAX_BYTES = 8 * 1024
const RELEASE_RECORD = '.install-complete.json'
const RELEASE_ID = /^[a-f0-9]{64}$/

export type { InstallPhase, InstallState }

export interface AntigravityExecutable {
  executablePath: string
  harnessPath: string
  source: 'override' | 'managed' | 'path'
  version: string | null
  /** The folder of the managed release this is, so it is not removed while it is in use. */
  managedVersionDirectory: string | null
}

export class InstallError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message)
    this.name = 'InstallError'
  }
}

interface InstalledRelease {
  releaseId: string
  version: string
  executable: { name: string; bytes: number }
  harness: { name: string; bytes: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(path: string): unknown {
  const info = statSync(path)
  if (!info.isFile() || info.size > RECORD_MAX_BYTES) throw new InstallError('The managed runtime record is invalid. Reinstall Antigravity.', 'resolve')
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function isInstalledRelease(value: unknown): value is InstalledRelease {
  if (!isRecord(value) || typeof value.releaseId !== 'string' || typeof value.version !== 'string') return false
  const file = (entry: unknown): boolean => isRecord(entry) && typeof entry.name === 'string' && typeof entry.bytes === 'number'
  return file(value.executable) && file(value.harness)
}

export interface InstallerOptions {
  /** The folder Cubex keeps Antigravity's things in. */
  base: string
  platform?: NodeJS.Platform
  arch?: string
  /** The release to install. Defaults to the one for this platform; null when Google publishes none. For tests. */
  asset?: AntigravityReleaseAsset | null
  fetch?: typeof fetch
  /** Starts the downloaded runtime and checks that it is the release. Replaced in tests. */
  validate?: (executable: AntigravityExecutable, expectedVersion: string, signal: AbortSignal) => Promise<void>
  /** How much room the disk has, in bytes, for the folder given. Replaced in tests. */
  freeBytes?: (directory: string) => number | undefined
}

type Listener = (state: InstallState) => void

export class AntigravityInstaller {
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  readonly asset: AntigravityReleaseAsset | null
  readonly managedDirectory: string
  private readonly versionsDirectory: string
  private readonly activePath: string
  private readonly names: { executable: string; harness: string }
  private current: InstallState
  private readonly listeners = new Set<Listener>()
  private running: { operationId: string; abort: AbortController; done: Promise<void> } | undefined
  /** Managed release folders that a runtime is running from, with how many. */
  private readonly leases = new Map<string, number>()

  constructor(private readonly options: InstallerOptions) {
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.asset = options.asset === undefined ? resolveAntigravityReleaseAsset(this.platform, this.arch) : options.asset
    this.names = antigravityProgramNames(this.platform)
    this.managedDirectory = join(options.base, 'runtime', `${this.platform}-${this.arch}`)
    this.versionsDirectory = join(this.managedDirectory, 'versions')
    this.activePath = join(this.managedDirectory, 'active.json')
    this.current = {
      operationId: null,
      phase: 'idle',
      downloadedBytes: 0,
      totalBytes: this.asset?.archiveBytes ?? null,
      version: this.asset?.version ?? null,
      installedVersion: null,
      canRemove: existsSync(this.managedDirectory),
      message: null
    }
    // What is installed from before.
    try {
      const installed = this.activeRelease()
      if (installed) this.current = { ...this.current, installedVersion: installed.version }
    } catch (error) {
      this.current = { ...this.current, phase: 'failed', message: error instanceof Error ? error.message : 'The managed Antigravity runtime is incomplete. Remove it and reinstall.' }
    }
  }

  get state(): InstallState {
    return this.current
  }

  /** Called with each change of state. Returns how to stop being called. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<InstallState>): void {
    this.current = { ...this.current, ...patch }
    for (const listener of [...this.listeners]) {
      try { listener(this.current) } catch { /* a window that is gone must not stop an install */ }
    }
  }

  private get isRunning(): boolean {
    return this.current.phase === 'downloading' || this.current.phase === 'extracting' || this.current.phase === 'verifying'
  }

  // -- Finding what is installed ---------------------------------------------------------------

  private isExecutable(path: string, bytes?: number): boolean {
    try {
      const info = statSync(path)
      return info.isFile() && (bytes === undefined || info.size === bytes) && (this.platform === 'win32' || (info.mode & 0o111) !== 0)
    } catch {
      return false
    }
  }

  private completedRelease(releaseId: string): AntigravityExecutable {
    const directory = join(this.versionsDirectory, releaseId)
    const record = readRecord(join(directory, RELEASE_RECORD))
    if (
      !isInstalledRelease(record) ||
      record.releaseId !== releaseId ||
      record.executable.name !== this.names.executable ||
      record.harness.name !== this.names.harness ||
      !Number.isSafeInteger(record.executable.bytes) || record.executable.bytes <= 0 ||
      !Number.isSafeInteger(record.harness.bytes) || record.harness.bytes <= 0 ||
      !record.version.trim() ||
      !this.isExecutable(join(directory, this.names.executable), record.executable.bytes) ||
      !this.isExecutable(join(directory, this.names.harness), record.harness.bytes)
    ) {
      throw new InstallError('The managed Antigravity runtime is incomplete. Reinstall it.', 'resolve')
    }
    return {
      executablePath: join(directory, this.names.executable),
      harnessPath: join(directory, this.names.harness),
      source: 'managed',
      version: record.version,
      managedVersionDirectory: directory
    }
  }

  private activeRelease(): AntigravityExecutable | undefined {
    if (!existsSync(this.activePath)) return undefined
    const active = readRecord(this.activePath)
    if (!isRecord(active) || typeof active.releaseId !== 'string' || !RELEASE_ID.test(active.releaseId)) {
      throw new InstallError('The managed runtime record is invalid. Reinstall Antigravity.', 'resolve')
    }
    return this.completedRelease(active.releaseId)
  }

  /** The runtime Cubex installed, or undefined when it has not installed one. A damaged install is an error. */
  resolve(): AntigravityExecutable | undefined {
    return this.activeRelease()
  }

  /** The runtime from a program the person points at: it needs its harness beside it, and may be one of Cubex's own releases. */
  fromExternal(candidate: string, source: 'override' | 'path'): AntigravityExecutable | undefined {
    if (!this.isExecutable(candidate)) return undefined
    const executablePath = realpathSync(candidate)
    const directory = dirname(executablePath)
    const harnessPath = join(directory, this.names.harness)
    if (!this.isExecutable(harnessPath)) return undefined
    let versions: string | undefined
    try { versions = realpathSync(this.versionsDirectory) } catch { /* nothing installed here */ }
    if (versions && dirname(directory) === versions && RELEASE_ID.test(basename(directory))) {
      return { ...this.completedRelease(basename(directory)), executablePath, harnessPath, source }
    }
    return { executablePath, harnessPath, source, version: null, managedVersionDirectory: null }
  }

  /** Holds a release in place while a runtime runs from it. Call the function it returns when that runtime has ended. */
  lease(executable: AntigravityExecutable): () => void {
    const directory = executable.managedVersionDirectory
    if (!directory) return () => undefined
    this.leases.set(directory, (this.leases.get(directory) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.leases.get(directory) ?? 1) - 1
      if (remaining > 0) this.leases.set(directory, remaining)
      else this.leases.delete(directory)
    }
  }

  /** Whether a runtime is running from a release of Cubex's. */
  get inUse(): boolean {
    return this.leases.size > 0
  }

  /** Resolves when no runtime is running from a release, or when the time is up. True when none is: for a runtime that was just stopped, which ends a moment later. */
  async whenIdle(timeoutMs = 3_000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (this.leases.size > 0 && Date.now() < end) await new Promise<void>((done) => setTimeout(done, 25))
    return this.leases.size === 0
  }

  // -- Installing -------------------------------------------------------------------------------

  /** Begins installing in the background. Returns the state it began in; the rest is reported through `subscribe`. */
  start(): InstallState {
    if (this.isRunning) return this.current
    const asset = this.asset
    if (!asset) throw new InstallError(`Google does not publish an Antigravity runtime for ${this.platform}-${this.arch}.`, 'start')
    const operationId = randomUUID()
    const abort = new AbortController()
    this.set({ operationId, phase: 'downloading', downloadedBytes: 0, totalBytes: asset.archiveBytes, message: 'Downloading Google\'s Antigravity runtime.' })
    const done = this.install(asset, abort.signal).then(
      () => undefined,
      (error: unknown) => {
        if (this.current.operationId !== operationId || this.current.phase === 'succeeded') return
        const cancelled = abort.signal.aborted && !(error instanceof InstallError && error.operation === 'timeout')
        this.set({
          phase: cancelled ? 'cancelled' : 'failed',
          message: cancelled
            ? 'Installation cancelled. The previous runtime is unchanged.'
            : error instanceof InstallError || error instanceof ZipError
              ? error.message
              : 'Could not finish the Antigravity installation. Check disk space and folder access.'
        })
      }
    ).finally(() => { if (this.running?.operationId === operationId) this.running = undefined })
    this.running = { operationId, abort, done }
    return this.current
  }

  /** Resolves when the install that is running has ended, however it ended. */
  async finished(): Promise<void> {
    await this.running?.done
  }

  cancel(operationId: string): InstallState {
    if (this.current.operationId !== operationId) throw new InstallError('This installation is no longer current. Refresh its status before cancelling.', 'cancel')
    if (this.running?.operationId === operationId && this.isRunning) this.running.abort.abort()
    return this.current
  }

  /** Stops an install that is going, whatever it is: the app is quitting. The release that was active stays so. */
  stop(): void {
    this.running?.abort.abort()
  }

  /** Remove everything of Cubex's: the installed releases and the record that points at one. Refused while something is using them. */
  remove(): void {
    if (this.isRunning) throw new InstallError('The runtime is being installed. Cancel the installation or wait for it to finish, then remove it.', 'remove')
    if (this.leases.size > 0) throw new InstallError('Antigravity is still running. Stop its task or wait for it to finish, then remove the runtime.', 'remove')
    try {
      rmSync(this.managedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      throw new InstallError('Could not remove the Antigravity runtime. Check for open processes and try again.', 'remove')
    }
    this.set({ operationId: null, phase: 'idle', downloadedBytes: 0, installedVersion: null, canRemove: false, message: null })
  }

  private async install(asset: AntigravityReleaseAsset, signal: AbortSignal): Promise<void> {
    const check = (): void => { if (signal.aborted) throw new InstallError('Cancelled.', 'cancel') }
    mkdirSync(this.versionsDirectory, { recursive: true })
    this.set({ canRemove: true })
    const destination = join(this.versionsDirectory, asset.sha256)

    // The same release is there already: check that it runs, and make it the active one.
    if (existsSync(destination)) {
      const existing = this.completedRelease(asset.sha256)
      if (existing.version !== asset.version) throw new InstallError('The existing managed release has the wrong version. Remove it before reinstalling.', 'verify')
      this.set({ phase: 'verifying', message: 'Checking the installed runtime.' })
      await this.validate(existing, asset.version, signal)
      this.activate(asset)
      return
    }

    const free = (this.options.freeBytes ?? freeBytesOf)(this.versionsDirectory)
    const required = antigravityInstallBytes(asset)
    if (free !== undefined && free < required) {
      throw new InstallError(`Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`, 'download')
    }

    const staging = mkdtempSync(join(this.versionsDirectory, '.install-'))
    try {
      const archivePath = join(staging, 'download.zip')
      const pairDirectory = join(staging, 'runtime')
      mkdirSync(pairDirectory)
      await this.download(asset, archivePath, signal)
      check()
      this.set({ phase: 'extracting', message: 'Extracting the verified runtime.' })
      await this.extract(asset, archivePath, pairDirectory)
      rmSync(archivePath, { force: true })
      if (this.platform !== 'win32') {
        chmodSync(join(pairDirectory, asset.executable.name), 0o755)
        chmodSync(join(pairDirectory, asset.harness.name), 0o755)
      }
      check()
      this.set({ phase: 'verifying', message: 'Checking the downloaded runtime.' })
      await this.validate({
        executablePath: join(pairDirectory, asset.executable.name),
        harnessPath: join(pairDirectory, asset.harness.name),
        source: 'managed',
        version: asset.version,
        managedVersionDirectory: pairDirectory
      }, asset.version, signal)
      check()
      const record: InstalledRelease = { releaseId: asset.sha256, version: asset.version, executable: asset.executable, harness: asset.harness }
      writeFileSync(join(pairDirectory, RELEASE_RECORD), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
      try {
        renameSync(pairDirectory, destination)
      } catch {
        // Another install published the same release first: it is fine if it is complete and says it is this version.
        let existing: AntigravityExecutable
        try {
          existing = this.completedRelease(asset.sha256)
        } catch {
          throw new InstallError('Could not publish the Antigravity runtime. The previous release is unchanged. Try again.', 'activate')
        }
        if (existing.version !== asset.version) throw new InstallError('Another installation published a different Antigravity release.', 'activate')
        await this.validate(existing, asset.version, signal)
      }
      this.activate(asset)
    } finally {
      try { rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept by the next install */ }
    }
  }

  /** Points at the release, which is what makes it the one in use. A pointer that is half written is never seen. */
  private activate(asset: AntigravityReleaseAsset): void {
    try {
      const temporary = `${this.activePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ releaseId: asset.sha256 })}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.activePath)
    } catch {
      throw new InstallError('Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.', 'activate')
    }
    this.set({ phase: 'succeeded', installedVersion: asset.version, message: null })
  }

  private async download(asset: AntigravityReleaseAsset, archivePath: string, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const both = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      // The plain archive is asked for, so what is counted is what is checked. A host that compresses it anyway is decoded by fetch.
      response = await (this.options.fetch ?? fetch)(asset.url, { signal: both, redirect: 'follow', headers: { 'accept-encoding': 'identity' } })
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new InstallError('The Antigravity download took too long and was stopped.', 'timeout')
      if (signal.aborted) throw new InstallError('Cancelled.', 'cancel')
      throw new InstallError(`Could not reach Google to download Antigravity: ${error instanceof Error ? error.message : String(error)}`, 'download')
    }
    if (!response.ok || !response.body) throw new InstallError(`Google's server answered ${response.status} when Antigravity was asked for.`, 'download')
    // A compressed body's length is the compressed size, so only a plain one can be compared with the pinned size up front.
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    const length = response.headers.get('content-length')
    if ((encoding === null || encoding === undefined || encoding === 'identity') && length !== null && Number(length) !== asset.archiveBytes) {
      throw new InstallError('The Antigravity download size did not match the pinned release.', 'download')
    }
    const hash = createHash('sha256')
    const file = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
    const failed = new Promise<never>((_, reject) => file.once('error', reject))
    failed.catch(() => undefined)
    let downloaded = 0
    let lastProgress = Date.now()
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), failed])
        if (done) break
        downloaded += value.byteLength
        if (downloaded > asset.archiveBytes) {
          void reader.cancel().catch(() => undefined)
          throw new InstallError('The Antigravity download exceeded the pinned release size.', 'download')
        }
        hash.update(value)
        if (!file.write(value)) await Promise.race([once(file, 'drain'), failed])
        const now = Date.now()
        if (now - lastProgress >= 250 || downloaded === asset.archiveBytes) {
          lastProgress = now
          this.set({ downloadedBytes: downloaded })
        }
      }
      file.end()
      await Promise.race([once(file, 'finish'), failed])
    } catch (error) {
      file.destroy()
      if (error instanceof InstallError) throw error
      if (timeout.aborted && !signal.aborted) throw new InstallError('The Antigravity download took too long and was stopped.', 'timeout')
      if (signal.aborted) throw new InstallError('Cancelled.', 'cancel')
      throw new InstallError(`The Antigravity download was interrupted: ${error instanceof Error ? error.message : String(error)}`, 'download')
    }
    this.set({ downloadedBytes: downloaded })
    if (downloaded !== asset.archiveBytes || hash.digest('hex') !== asset.sha256) {
      throw new InstallError('The Antigravity download failed its size or SHA-256 check. Nothing was installed.', 'download')
    }
  }

  private async extract(asset: AntigravityReleaseAsset, archivePath: string, pairDirectory: string): Promise<void> {
    const archive = await ZipArchive.open(archivePath)
    try {
      if (archive.entries.length !== 2) throw new InstallError('The archive must contain exactly the Antigravity runtime and its harness.', 'extract')
      const seen = new Set<string>()
      for (const entry of archive.entries) {
        const expected = [asset.executable, asset.harness].find((file) => file.name === entry.fileName)
        if (
          !expected ||
          seen.has(entry.fileName) ||
          entry.fileName.includes('/') || entry.fileName.includes('\\') ||
          !isPlainFile(entry) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod) ||
          entry.uncompressedSize !== expected.bytes
        ) {
          throw new InstallError('The archive contains an unexpected, unsafe, or incorrectly sized member.', 'extract')
        }
        seen.add(entry.fileName)
        await archive.extract(entry, join(pairDirectory, entry.fileName), { mode: 0o700 })
      }
      if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) {
        throw new InstallError('The archive is missing the Antigravity runtime or its harness.', 'extract')
      }
    } finally {
      await archive.close()
    }
  }

  private async validate(executable: AntigravityExecutable, expectedVersion: string, signal: AbortSignal): Promise<void> {
    const check = this.options.validate
    if (!check) throw new InstallError('There is no way to check the runtime.', 'verify')
    try {
      await check(executable, expectedVersion, signal)
    } catch (error) {
      if (signal.aborted) throw new InstallError('Cancelled.', 'cancel')
      if (error instanceof InstallError) throw error
      throw new InstallError('The downloaded Antigravity runtime could not start in this environment.', 'verify')
    }
  }
}

/** How much room the disk has for a folder, or undefined when this system cannot say. */
function freeBytesOf(directory: string): number | undefined {
  try {
    const info = statfsSync(directory, { bigint: true })
    return Number(info.bavail * info.bsize)
  } catch {
    return undefined
  }
}

/** For tests and for places that need the folder without making an installer. */
export function managedDirectoryFor(base: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return resolvePath(join(base, 'runtime', `${platform}-${arch}`))
}
