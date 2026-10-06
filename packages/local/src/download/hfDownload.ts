import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, statfs, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hfStatusMessage, isSafePathSegment } from './hfRef'

/**
 * Resumable, verified file download. The bytes go to `<dest>.part`, are checked
 * against a SHA-256 when one is known, and only then renamed to `<dest>`, so the
 * final path never holds a partial or corrupt model. A `<dest>.part.json` sidecar
 * records which remote file the partial bytes belong to; a partial file is only
 * resumed (HTTP Range) when the sidecar still matches.
 */

export type DownloadErrorCode =
  | 'disk_space'
  | 'checksum'
  | 'http'
  | 'incomplete'
  | 'unsafe_path'
  | 'network'
  | 'stalled'
  | 'write'
  | 'cancelled'

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    /** Worth another attempt (resuming from the bytes already on disk). */
    readonly retryable = false
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface FileProgress {
  phase: 'downloading' | 'verifying' | 'finalizing'
  completedBytes: number
  totalBytes?: number
}

export interface DownloadFileOptions {
  url: string
  destPath: string
  /** The models directory; `destPath` must be inside it and reach it through real directories. */
  rootDir: string
  expectedSize?: number
  /** Lowercase hex SHA-256 from the LFS pointer; falls back to a SHA-256 ETag when absent. */
  expectedSha256?: string
  fetch?: typeof fetch
  /** Extra request headers, for example Authorization. Dropped by fetch on cross-origin redirects. */
  headers?: Record<string, string>
  signal?: AbortSignal
  onProgress?: (p: FileProgress) => void
  /** Free bytes on the volume holding `dir`. Defaults to `statfs`. */
  freeBytes?: (dir: string) => Promise<number>
  /** Free space that must remain after the download. Default 512 MiB. */
  reserveBytes?: number
  /** Keep the `.part` file when cancelled instead of deleting it. Default false. */
  keepPartialOnCancel?: boolean
  /** Attempts before giving up on a retryable failure. Default 4. */
  maxAttempts?: number
  /** Delay before attempt `n + 1`, in ms. Default exponential from 1 s, capped at 30 s. */
  retryDelayMs?: (attempt: number) => number
  /** Abort an attempt when no bytes arrive for this long. Default 30 s. */
  stallTimeoutMs?: number
}

export interface DownloadFileResult {
  path: string
  bytes: number
  sha256?: string
  /** True when the file matched a published SHA-256. */
  verified: boolean
  /** Bytes that were already on disk when this run resumed (0 for a fresh download). */
  resumedFromBytes: number
  /** The final file already existed and matched, so nothing was downloaded. */
  alreadyPresent: boolean
}

const GIB = 1024 ** 3
const WRITE_BUFFER = 1024 * 1024
export const DEFAULT_RESERVE_BYTES = 512 * 1024 * 1024
const DEFAULT_RESERVE = DEFAULT_RESERVE_BYTES

export function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`
}

/** Free bytes for the volume holding `dir`; unlimited when the platform cannot say. */
export async function freeDiskBytes(dir: string): Promise<number> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Throw a clear `disk_space` error when `dir`'s volume cannot hold `remainingBytes` plus a reserve. */
export async function assertFreeSpace(options: {
  dir: string
  remainingBytes: number
  reserveBytes: number
  freeBytes: (dir: string) => Promise<number>
  /** What is being downloaded, for the message. */
  name: string
}): Promise<void> {
  const { dir, remainingBytes, reserveBytes, name } = options
  const free = await options.freeBytes(dir)
  if (Number.isFinite(free) && free < remainingBytes + reserveBytes) {
    throw new DownloadError(
      'disk_space',
      `Not enough free disk space for ${name}: it needs about ${formatGb(remainingBytes)} more in ${dir}, but only ${formatGb(free)} is free${reserveBytes > 0 ? ` (keeping ${formatGb(reserveBytes)} spare)` : ''}. Free up space or choose another models folder.`
    )
  }
}

const unsafe = (message: string): DownloadError => new DownloadError('unsafe_path', message)

/**
 * Create the destination directory one level at a time and refuse to pass
 * through any symlink or junction below the models root, so a swapped link
 * cannot redirect a model download outside it.
 */
export async function ensureSafeDestination(rootDir: string, destPath: string): Promise<void> {
  const root = resolve(rootDir)
  const dest = resolve(destPath)
  const rel = relative(root, dest)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw unsafe('The download location is outside the models folder.')
  const segments = rel.split(sep)
  if (!segments.every(isSafePathSegment)) throw unsafe('The download location contains an unsafe name.')

  await mkdir(root, { recursive: true })
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let info = await lstat(current).catch(() => undefined)
    if (!info) {
      await mkdir(current)
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw unsafe(`"${current}" is a link or not a folder, so the download was blocked.`)
    }
  }
  for (const file of [dest, `${dest}.part`, `${dest}.part.json`]) {
    const info = await lstat(file).catch(() => undefined)
    if (info && (info.isSymbolicLink() || !info.isFile())) {
      throw unsafe(`"${file}" is a link or not a regular file, so the download was blocked.`)
    }
  }
}

export function extractSha256(headers: Headers): string | undefined {
  for (const name of ['x-linked-etag', 'etag']) {
    const value = headers.get(name)?.replace(/^W\//, '').replace(/"/g, '').trim()
    if (value && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  }
  return undefined
}

interface Sidecar {
  url: string
  size?: number
  sha256?: string
}

async function sidecarMatches(path: string, want: Sidecar): Promise<boolean> {
  try {
    const have = JSON.parse(await readFile(path, 'utf8')) as Sidecar
    if (have.url !== want.url) return false
    if (want.size !== undefined && have.size !== undefined && have.size !== want.size) return false
    if (want.sha256 && have.sha256 && have.sha256 !== want.sha256) return false
    return true
  } catch {
    return false
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  const info = await lstat(path).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile()) throw unsafe(`"${path}" is not a regular file, so the download was blocked.`)
  return info.size
}

async function removeQuietly(...paths: string[]): Promise<void> {
  for (const p of paths) await rm(p, { force: true }).catch(() => undefined)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (ms <= 0 || signal?.aborted) return resolveSleep()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolveSleep()
    }
  })
}

async function hashFile(
  path: string,
  total: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: FileProgress) => void) | undefined
): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: WRITE_BUFFER })
  let done = 0
  for await (const chunk of stream) {
    if (signal?.aborted) {
      stream.destroy()
      throw new DownloadError('cancelled', 'Download cancelled.')
    }
    hash.update(chunk as Buffer)
    done += (chunk as Buffer).length
    onProgress?.({ phase: 'verifying', completedBytes: done, totalBytes: total })
  }
  return hash.digest('hex')
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    offset += bytesWritten
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { message?: string; code?: string } }).cause
    return cause?.message ? `${err.message} (${cause.message})` : err.message
  }
  return String(err)
}

export async function downloadFile(options: DownloadFileOptions): Promise<DownloadFileResult> {
  const doFetch = options.fetch ?? fetch
  const dest = options.destPath
  const part = `${dest}.part`
  const sidecarPath = `${dest}.part.json`
  const name = dest.slice(Math.max(dest.lastIndexOf('/'), dest.lastIndexOf('\\')) + 1)
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4)
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)))
  const reserve = options.reserveBytes ?? DEFAULT_RESERVE
  const freeBytes = options.freeBytes ?? freeDiskBytes
  const stallMs = options.stallTimeoutMs ?? 30_000
  const cancelled = (): DownloadError => new DownloadError('cancelled', 'Download cancelled.')

  let totalBytes = options.expectedSize
  let sha256 = options.expectedSha256?.toLowerCase()
  let resumedFrom = 0

  const cleanupAfterCancel = async (): Promise<void> => {
    if (!options.keepPartialOnCancel) await removeQuietly(part, sidecarPath)
  }

  if (options.signal?.aborted) throw cancelled()
  await ensureSafeDestination(options.rootDir, dest)

  // A finished copy may already be in place.
  const finalSize = await fileSize(dest)
  if (finalSize !== undefined) {
    if (totalBytes !== undefined && finalSize === totalBytes) {
      if (!sha256) return { path: dest, bytes: finalSize, verified: false, resumedFromBytes: 0, alreadyPresent: true }
      const actual = await hashFile(dest, finalSize, options.signal, options.onProgress)
      if (actual === sha256) return { path: dest, bytes: finalSize, sha256, verified: true, resumedFromBytes: 0, alreadyPresent: true }
    }
    await removeQuietly(dest) // wrong size or checksum: replace it
  }

  // One attempt: bring the `.part` file up to the full length.
  const attempt = async (): Promise<void> => {
    let existing = (await fileSize(part)) ?? 0
    const identity = (): Sidecar => ({
      url: options.url,
      ...(totalBytes !== undefined ? { size: totalBytes } : {}),
      ...(sha256 ? { sha256 } : {})
    })
    if (existing > 0 && !(await sidecarMatches(sidecarPath, identity()))) {
      await removeQuietly(part, sidecarPath)
      existing = 0
    }
    if (totalBytes !== undefined && existing > totalBytes) {
      await removeQuietly(part, sidecarPath)
      existing = 0
    }
    if (totalBytes !== undefined && existing === totalBytes) {
      resumedFrom = Math.max(resumedFrom, existing)
      return // already complete; verification follows
    }

    const dir = dirname(dest)
    const checkSpace = (remaining: number): Promise<void> =>
      assertFreeSpace({ dir, remainingBytes: remaining, reserveBytes: reserve, freeBytes, name })
    if (totalBytes !== undefined) await checkSpace(totalBytes - existing)
    await writeFile(sidecarPath, JSON.stringify(identity()))

    const inner = new AbortController()
    let stalled = false
    const onOuterAbort = (): void => inner.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        inner.abort()
      }, stallMs)
    }

    let handle: FileHandle | undefined
    try {
      if (options.signal?.aborted) throw cancelled()
      arm()
      let res: Response
      try {
        res = await doFetch(options.url, {
          headers: { ...(options.headers ?? {}), ...(existing > 0 ? { range: `bytes=${existing}-` } : {}) },
          signal: inner.signal
        })
      } catch (err) {
        throw translateNetworkError(err, options.signal, stalled)
      }

      if (res.status === 416 && existing > 0) {
        const m = /bytes \*\/(\d+)/.exec(res.headers.get('content-range') ?? '')
        if (m && Number(m[1]) === existing) {
          totalBytes = existing
          return // the partial file is the whole file
        }
        await removeQuietly(part, sidecarPath)
        throw new DownloadError('incomplete', 'The partial download no longer matches the server; restarting.', true)
      }
      if (!res.ok) {
        const status = res.status
        throw new DownloadError(
          'http',
          [401, 403, 404, 429].includes(status) ? hfStatusMessage(status, name) : `The download server returned HTTP ${status} for ${name}.`,
          status >= 500 || status === 429 || status === 408
        )
      }
      if (!res.body) throw new DownloadError('network', `The server sent an empty response for ${name}.`, true)

      // 200 to a Range request means the server ignored it: start over.
      let startAt = existing
      if (existing > 0 && res.status !== 206) {
        startAt = 0
        await removeQuietly(part)
      } else if (res.status === 206) {
        const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(res.headers.get('content-range') ?? '')
        if (!m || Number(m[1]) !== existing) {
          await removeQuietly(part, sidecarPath)
          throw new DownloadError('incomplete', 'The server resumed at the wrong offset; restarting.', true)
        }
        if (m[2] !== '*' && totalBytes === undefined) totalBytes = Number(m[2])
      }
      if (startAt === 0) resumedFrom = 0
      else resumedFrom = Math.max(resumedFrom, startAt)

      if (totalBytes === undefined) {
        const length = Number(res.headers.get('content-length'))
        if (Number.isFinite(length) && length > 0) totalBytes = startAt + length
      }
      const etagSha = extractSha256(res.headers)
      if (!sha256 && etagSha) sha256 = etagSha
      if (existing === 0 || startAt === 0) {
        if (totalBytes !== undefined) await checkSpace(totalBytes - startAt)
      }
      await writeFile(sidecarPath, JSON.stringify(identity()))

      handle = await open(part, startAt > 0 ? 'a' : 'w')
      let received = startAt
      const reader = res.body.getReader()
      const pending: Uint8Array[] = []
      let pendingBytes = 0
      const flush = async (): Promise<void> => {
        if (pendingBytes === 0) return
        const buffer = Buffer.concat(pending, pendingBytes)
        pending.length = 0
        pendingBytes = 0
        try {
          await writeAll(handle!, buffer)
        } catch (err) {
          throw new DownloadError('write', `Could not write ${name}: ${describeError(err)}`)
        }
      }
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          arm()
          pending.push(value)
          pendingBytes += value.length
          received += value.length
          if (pendingBytes >= WRITE_BUFFER) await flush()
          options.onProgress?.({ phase: 'downloading', completedBytes: received, ...(totalBytes !== undefined ? { totalBytes } : {}) })
        }
      } catch (err) {
        await flush().catch(() => undefined) // keep what arrived so a retry can resume from it
        if (err instanceof DownloadError) throw err
        throw translateNetworkError(err, options.signal, stalled)
      }
      await flush()
      await handle.sync().catch(() => undefined)
      if (totalBytes !== undefined && received < totalBytes) {
        throw new DownloadError('incomplete', `The connection closed after ${formatGb(received)} of ${formatGb(totalBytes)}.`, true)
      }
      if (totalBytes === undefined) totalBytes = received
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      options.signal?.removeEventListener('abort', onOuterAbort)
      await handle?.close().catch(() => undefined)
    }
  }

  try {
    for (let n = 1; ; n++) {
      try {
        await attempt()
        break
      } catch (err) {
        if (options.signal?.aborted) throw cancelled()
        if (!(err instanceof DownloadError) || !err.retryable || n >= maxAttempts) throw err
        await sleep(retryDelay(n), options.signal)
        if (options.signal?.aborted) throw cancelled()
      }
    }

    const size = (await fileSize(part)) ?? 0
    if (totalBytes !== undefined && size !== totalBytes) {
      await removeQuietly(part, sidecarPath)
      throw new DownloadError('incomplete', `${name} ended up ${formatGb(size)} instead of ${formatGb(totalBytes)}; it was discarded.`)
    }

    let verified = false
    if (sha256) {
      const actual = await hashFile(part, size, options.signal, options.onProgress)
      if (actual !== sha256) {
        await removeQuietly(part, sidecarPath)
        throw new DownloadError(
          'checksum',
          `Checksum mismatch for ${name}: the downloaded file does not match the SHA-256 published by Hugging Face. The partial file was deleted; try again.`
        )
      }
      verified = true
    }

    options.onProgress?.({ phase: 'finalizing', completedBytes: size, totalBytes: size })
    await ensureSafeDestination(options.rootDir, dest) // re-check just before the rename
    await rename(part, dest)
    await removeQuietly(sidecarPath)
    return { path: dest, bytes: size, ...(sha256 ? { sha256 } : {}), verified, resumedFromBytes: resumedFrom, alreadyPresent: false }
  } catch (err) {
    if (err instanceof DownloadError && err.code === 'cancelled') {
      await cleanupAfterCancel()
    }
    throw err
  }
}

function translateNetworkError(err: unknown, signal: AbortSignal | undefined, stalled: boolean): DownloadError {
  if (signal?.aborted) return new DownloadError('cancelled', 'Download cancelled.')
  if (stalled) return new DownloadError('stalled', 'The download stalled: no data arrived for a while.', true)
  if (err instanceof DownloadError) return err
  return new DownloadError('network', `Network error while downloading: ${describeError(err)}`, true)
}

/** Remove a leftover partial download and its sidecar (used when a pull is cancelled elsewhere). */
export async function discardPartial(destPath: string): Promise<void> {
  await removeQuietly(`${destPath}.part`, `${destPath}.part.json`)
}
