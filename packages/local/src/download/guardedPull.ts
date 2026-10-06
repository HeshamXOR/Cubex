import type { LocalRuntime, PullEstimate, PullProgressUpdate } from '../runtimes/LocalRuntime'
import { checkFreeSpace } from './diskSpace'
import { DEFAULT_RESERVE_BYTES, freeDiskBytes } from './hfDownload'

export interface GuardedPullOptions {
  runtime: LocalRuntime
  modelId: string
  /** An approximate size for a model the runtime cannot size itself. */
  catalogBytes?: (modelId: string) => number | undefined
  /** Free bytes on the volume holding a folder. Defaults to `statfs`. */
  freeBytes?: (dir: string) => Promise<number>
  reserveBytes?: number
  platform?: NodeJS.Platform
}

/** The same sentence the runtime uses when it fails to connect, so a refusal before and after the request read alike. */
function unreachableMessage(runtime: LocalRuntime, endpoint: string | undefined, error: string | undefined): string {
  const at = endpoint ? ` at ${endpoint}` : ''
  if (error?.startsWith('HTTP ')) return `${runtime.name} answered ${error}${at}. Restart ${runtime.name}, then try again.`
  return `Could not reach ${runtime.name}${at}. Make sure ${runtime.name} is running, then try again.`
}

async function sizeOf(options: GuardedPullOptions, signal: AbortSignal): Promise<PullEstimate | undefined> {
  const { runtime, modelId } = options
  const exact = await runtime.estimatePull?.(modelId, signal).catch(() => undefined)
  if (exact) return exact
  const approximate = options.catalogBytes?.(modelId)
  return approximate ? { totalBytes: approximate, remainingBytes: approximate, source: 'catalog' } : undefined
}

/**
 * One pull with the checks a person would want first:
 *  1. the runtime answers, or the pull fails at once with the fix;
 *  2. the model is sized (the runtime's registry, else the built-in catalog) and the
 *     disk is checked before the first byte;
 *  3. while it downloads, the disk is checked again whenever the runtime reveals more
 *     of the model, because a name the registry did not know cannot be sized up front.
 * Every failure is a terminal event with an `errorCode`; the function itself only
 * throws for programming errors.
 */
export async function runGuardedPull(
  options: GuardedPullOptions,
  onProgress: (p: PullProgressUpdate) => void,
  signal: AbortSignal
): Promise<void> {
  const { runtime, modelId } = options
  const fail = (error: string, errorCode: NonNullable<PullProgressUpdate['errorCode']>): void =>
    onProgress({ status: 'error', phase: 'error', errorCode, done: true, error })
  if (!runtime.pull) return fail(`${runtime.name} cannot download models from Cubex. Install the model with its own tools.`, 'unsupported')

  const detected = await runtime.detect().catch(() => undefined)
  if (signal.aborted) return onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
  if (!detected?.running) return fail(unreachableMessage(runtime, detected?.endpoint, detected?.error), 'runtime_unreachable')

  const dir = runtime.modelsDir?.()
  const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES
  const freeBytes = options.freeBytes ?? freeDiskBytes
  const space = {
    reserveBytes,
    freeBytes,
    subject: 'This model',
    ...(options.platform ? { platform: options.platform } : {}),
    ...(runtime.diskAdvice ? { advice: runtime.diskAdvice } : {})
  }

  if (dir) {
    const estimate = await sizeOf(options, signal)
    if (signal.aborted) return onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
    if (estimate && estimate.remainingBytes > 0) {
      const verdict = await checkFreeSpace({ dir, requiredBytes: estimate.remainingBytes, ...space })
      if (!verdict.ok) return fail(verdict.message, 'disk_space')
    }
  }

  // The runtime gets its own signal so the guard below can stop it without the caller cancelling.
  const inner = new AbortController()
  const relay = (): void => inner.abort()
  signal.addEventListener('abort', relay, { once: true })
  let diskProblem: string | undefined
  let sawTerminal = false
  let checkedTotal = 0
  let checking: Promise<void> = Promise.resolve()

  const guard = (p: PullProgressUpdate): void => {
    if (!dir || p.done || p.totalBytes === undefined || p.completedBytes === undefined || p.totalBytes <= checkedTotal) return
    const remaining = p.totalBytes - p.completedBytes
    checkedTotal = p.totalBytes
    checking = checking.then(async () => {
      if (diskProblem || inner.signal.aborted) return
      const verdict = await checkFreeSpace({ dir, requiredBytes: remaining, ...space })
      if (verdict.ok) return
      diskProblem = verdict.message
      inner.abort()
    })
  }

  const forward = (p: PullProgressUpdate): void => {
    if (diskProblem && p.done) {
      if (sawTerminal) return
      sawTerminal = true
      return fail(diskProblem, 'disk_space')
    }
    if (p.done) sawTerminal = true
    onProgress(p)
    guard(p)
  }

  try {
    await runtime.pull(modelId, forward, inner.signal)
    await checking
    if (diskProblem && !sawTerminal) fail(diskProblem, 'disk_space')
  } finally {
    signal.removeEventListener('abort', relay)
  }
}
