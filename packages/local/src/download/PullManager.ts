import type { PullProgressUpdate } from '../runtimes/LocalRuntime'
import { createProgressThrottle } from './throttle'

/** A pull event as delivered to the app: a runtime update tagged with its pull. */
export interface PullEvent extends PullProgressUpdate {
  pullId: string
  modelId: string
}

export interface PullTask {
  pullId: string
  modelId: string
  /** Do the work, reporting progress; resolve when finished and honour `signal`. */
  run(onProgress: (p: PullProgressUpdate) => void, signal: AbortSignal): Promise<void>
}

export interface PullManagerOptions {
  /** Pulls that may run at once; the rest wait in a queue. Default 2. */
  maxConcurrent?: number
  /** Minimum gap between progress events for one pull. Default 250 ms. */
  minProgressIntervalMs?: number
  /** A pull that receives no new bytes for this long is reported as stalled. Default 30 s; 0 turns the watch off. */
  stallAfterMs?: number
  /** How often the stall watch looks. Default 5 s. */
  stallCheckMs?: number
  /** Clock, replaceable in tests. */
  now?: () => number
  onEvent: (event: PullEvent) => void
}

interface Entry {
  task: PullTask
  controller: AbortController
  state: 'queued' | 'running'
}

export const DEFAULT_MAX_CONCURRENT_PULLS = 2
export const DEFAULT_STALL_AFTER_MS = 30_000
const DEFAULT_STALL_CHECK_MS = 5_000

/**
 * Owns the lifecycle of model pulls for one runtime: a small concurrency cap with
 * a FIFO queue, per-pull cancellation, throttled progress, a watch that flags a
 * download whose bytes stopped arriving, and a guarantee of exactly one terminal
 * event (success, error or cancelled) per pull.
 */
export class PullManager {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: Entry[] = []
  private running = 0
  private readonly maxConcurrent: number
  private readonly stallAfterMs: number
  private readonly stallCheckMs: number
  private readonly now: () => number

  constructor(private readonly options: PullManagerOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PULLS))
    this.stallAfterMs = Math.max(0, options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS)
    this.stallCheckMs = Math.max(1, options.stallCheckMs ?? DEFAULT_STALL_CHECK_MS)
    this.now = options.now ?? Date.now
  }

  get runningCount(): number {
    return this.running
  }

  get queuedCount(): number {
    return this.queue.length
  }

  has(pullId: string): boolean {
    return this.entries.has(pullId)
  }

  enqueue(task: PullTask): void {
    const entry: Entry = { task, controller: new AbortController(), state: 'queued' }
    this.entries.set(task.pullId, entry)
    this.queue.push(entry)
    this.pump()
    if (entry.state === 'queued') this.announceQueue()
  }

  /** Cancel a queued or running pull. Returns false when the id is unknown. */
  cancel(pullId: string): boolean {
    const entry = this.entries.get(pullId)
    if (!entry) return false
    if (entry.state === 'queued') {
      this.queue.splice(this.queue.indexOf(entry), 1)
      this.entries.delete(pullId)
      this.options.onEvent({
        pullId,
        modelId: entry.task.modelId,
        status: 'cancelled',
        phase: 'cancelled',
        done: true
      })
      this.announceQueue()
      return true
    }
    entry.controller.abort()
    return true
  }

  /** Cancel everything, for app shutdown. */
  cancelAll(): void {
    for (const id of [...this.entries.keys()]) this.cancel(id)
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!
      void this.start(entry)
    }
  }

  private announceQueue(): void {
    this.queue.forEach((entry, i) =>
      this.options.onEvent({
        pullId: entry.task.pullId,
        modelId: entry.task.modelId,
        status: 'queued',
        phase: 'queued',
        queuePosition: i + 1,
        done: false
      })
    )
  }

  private async start(entry: Entry): Promise<void> {
    const { pullId, modelId } = entry.task
    entry.state = 'running'
    this.running++
    const throttle = createProgressThrottle<PullEvent>(this.options.onEvent, {
      ...(this.options.minProgressIntervalMs !== undefined ? { minIntervalMs: this.options.minProgressIntervalMs } : {})
    })
    let terminal = false
    // The row leaves "Queued" the moment the slot is taken, not when the runtime first answers.
    let latest: PullProgressUpdate = { status: 'preparing', phase: 'preparing', done: false }
    this.options.onEvent({ pullId, modelId, ...latest })
    let furthestBytes = -1
    let advancedAt = this.now()

    const emit = (p: PullProgressUpdate): void => {
      if (terminal) return
      if (p.done) terminal = true
      // Progress is new bytes or a new stage; the same status repeated is not.
      if (p.completedBytes !== undefined && p.completedBytes > furthestBytes) {
        furthestBytes = p.completedBytes
        advancedAt = this.now()
      } else if (p.phase !== latest.phase) {
        advancedAt = this.now()
      }
      latest = p
      throttle.push({ ...p, pullId, modelId })
    }

    // Checking a checksum or writing the manifest can be quiet for a while without being stuck.
    const watching = (p: PullProgressUpdate): boolean => p.phase === undefined || p.phase === 'preparing' || p.phase === 'downloading'
    const watch =
      this.stallAfterMs > 0
        ? setInterval(() => {
            if (terminal || !watching(latest)) return
            const idleMs = this.now() - advancedAt
            if (idleMs < this.stallAfterMs) return
            // The last speed and ETA describe a transfer that is no longer moving.
            const { speedBps: _speed, etaSeconds: _eta, ...rest } = latest
            throttle.push({ ...rest, pullId, modelId, stalledForSeconds: Math.floor(idleMs / 1000) })
          }, this.stallCheckMs)
        : undefined
    watch?.unref?.()

    const aborted = (): boolean => entry.controller.signal.aborted

    try {
      await entry.task.run(emit, entry.controller.signal)
      if (!terminal) {
        emit(
          aborted()
            ? { status: 'cancelled', phase: 'cancelled', done: true }
            : { status: 'success', phase: 'done', done: true }
        )
      }
    } catch (err) {
      if (!terminal) {
        emit(
          aborted()
            ? { status: 'cancelled', phase: 'cancelled', done: true }
            : { status: 'error', phase: 'error', errorCode: 'failed', done: true, error: err instanceof Error ? err.message : String(err) }
        )
      }
    } finally {
      if (watch) clearInterval(watch)
      throttle.cancel()
      this.running--
      this.entries.delete(pullId)
      this.pump()
      this.announceQueue()
    }
  }
}
