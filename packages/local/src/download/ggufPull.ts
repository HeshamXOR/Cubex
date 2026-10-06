import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PullProgressUpdate } from '../runtimes/LocalRuntime'
import { nearestExistingDir } from './diskSpace'
import {
  assertFreeSpace,
  DEFAULT_RESERVE_BYTES,
  downloadFile,
  freeDiskBytes,
  type DownloadFileResult
} from './hfDownload'
import { hfResolveUrl, parseHfReference, resolveHfPlan } from './hfRef'
import { SpeedMeter } from './speedMeter'

/**
 * Download a GGUF model from Hugging Face into `<modelsDir>/<owner>/<repo>/`.
 * Resolves what to fetch (one file, or every part of a split model), checks free
 * disk space for the whole model before the first byte, then downloads the parts
 * in order with one combined progress, each resumable and checksum-verified.
 */
export interface GgufPullOptions {
  /** What the user typed: `owner/repo`, `owner/repo:Q4_K_M`, `hf.co/...`, or a huggingface.co link. */
  modelRef: string
  file?: string
  revision?: string
  modelsDir: string
  /** Hugging Face access token for gated repositories. Only ever sent to huggingface.co. */
  token?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress: (p: PullProgressUpdate) => void
  freeBytes?: (dir: string) => Promise<number>
  reserveBytes?: number
  keepPartialOnCancel?: boolean
  maxAttempts?: number
  retryDelayMs?: (attempt: number) => number
  stallTimeoutMs?: number
}

export interface GgufPullResult {
  /** The file to load: the only file, or the first part of a split model. */
  modelPath: string
  files: DownloadFileResult[]
  /** Every file matched a published SHA-256. */
  verified: boolean
  repo: string
  revision: string
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Bytes of `dest` that are already on disk: a finished file counts in full, a resumable partial by its size. */
async function bytesOnDisk(dest: string, size: number): Promise<number> {
  const final = await lstat(dest).catch(() => undefined)
  if (final?.isFile() && final.size === size) return size
  const sidecar = await lstat(`${dest}.part.json`).catch(() => undefined)
  const part = sidecar ? await lstat(`${dest}.part`).catch(() => undefined) : undefined
  return part?.isFile() ? Math.min(part.size, size) : 0
}

export async function pullGguf(options: GgufPullOptions): Promise<GgufPullResult> {
  const { onProgress } = options
  onProgress({ status: 'resolving', phase: 'preparing', done: false })

  const ref = parseHfReference(options.modelRef, {
    ...(options.file ? { file: options.file } : {}),
    ...(options.revision ? { revision: options.revision } : {})
  })
  const plan = await resolveHfPlan(ref, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })

  const [owner, repoName] = ref.repo.split('/') as [string, string]
  const dir = join(options.modelsDir, owner, repoName)
  const targets = plan.files.map((file) => ({ file, dest: join(dir, baseName(file.path)) }))
  const total = targets.reduce((sum, t) => sum + t.file.size, 0)

  // One check for the whole model, so a two-part model fails before part one is fetched.
  const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES
  const freeBytes = options.freeBytes ?? freeDiskBytes
  let remaining = 0
  for (const t of targets) remaining += Math.max(0, t.file.size - (await bytesOnDisk(t.dest, t.file.size)))
  if (remaining > 0) {
    await assertFreeSpace({
      dir: await nearestExistingDir(dir),
      remainingBytes: remaining,
      reserveBytes,
      freeBytes,
      name: targets.length > 1 ? `${repoName} (${targets.length} parts)` : baseName(targets[0]!.file.path)
    })
  }

  const meter = new SpeedMeter()
  const results: DownloadFileResult[] = []
  let doneBefore = 0
  for (const [i, target] of targets.entries()) {
    const where = { fileName: baseName(target.file.path), fileIndex: i + 1, fileCount: targets.length }
    const result = await downloadFile({
      url: hfResolveUrl(plan.repo, plan.revision, target.file.path),
      destPath: target.dest,
      rootDir: options.modelsDir,
      expectedSize: target.file.size,
      ...(target.file.sha256 ? { expectedSha256: target.file.sha256 } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      freeBytes,
      reserveBytes,
      ...(options.keepPartialOnCancel !== undefined ? { keepPartialOnCancel: options.keepPartialOnCancel } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
      ...(options.stallTimeoutMs !== undefined ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
      onProgress: (p) => {
        if (p.phase === 'downloading') {
          const completed = doneBefore + p.completedBytes
          meter.add(completed)
          const speedBps = meter.bytesPerSecond()
          const etaSeconds = speedBps ? meter.etaSeconds(total - completed) : undefined
          onProgress({
            status: 'downloading',
            phase: 'downloading',
            completedBytes: completed,
            totalBytes: total,
            ...(speedBps !== undefined ? { speedBps } : {}),
            ...(etaSeconds !== undefined ? { etaSeconds } : {}),
            ...where,
            done: false
          })
        } else if (p.phase === 'verifying') {
          // While verifying, the byte counts describe the file being checked.
          onProgress({
            status: 'verifying',
            phase: 'verifying',
            completedBytes: p.completedBytes,
            ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}),
            ...where,
            done: false
          })
        } else {
          onProgress({ status: 'finalizing', phase: 'finalizing', ...where, done: false })
        }
      }
    })
    results.push(result)
    doneBefore += target.file.size
  }

  return {
    modelPath: targets[0]!.dest,
    files: results,
    verified: results.every((r) => r.verified),
    repo: plan.repo,
    revision: plan.revision
  }
}
