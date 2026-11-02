/**
 * Keeps the computer from going to sleep while Cubex is working: a reply that is generating, a goal being checked (a
 * test suite can run for minutes), or a background task that is running. A computer that sleeps pauses every process
 * and drops its network connections, so a long run would come back broken. This holds back the computer's sleep only;
 * the screen may still turn off.
 *
 * It looks every few seconds instead of listening for each start and end, so it cannot miss one and cannot leak a hold.
 */

/** The part of Electron's `powerSaveBlocker` this uses, so a test can supply its own. */
export interface PowerBlocker {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => void
}

export interface PowerKeeperOptions {
  blocker: PowerBlocker
  /** True while a reply is generating, a goal is being checked or a background task is running. */
  busy: () => boolean
  /** The person's setting. */
  enabled: () => boolean
  /** How often to look. */
  intervalMs?: number
}

export const POWER_CHECK_INTERVAL_MS = 4_000

export class PowerKeeper {
  private hold: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: PowerKeeperOptions) {}

  /** Begin looking. The first look is one interval from now, so starting this touches nothing else. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? POWER_CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Hold or release according to what is true now. A failing question counts as "no": a hold is never kept on a guess. */
  check(): void {
    let wanted = false
    try { wanted = this.options.enabled() && this.options.busy() } catch { wanted = false }
    if (wanted && this.hold === undefined) {
      try { this.hold = this.options.blocker.start('prevent-app-suspension') } catch { this.hold = undefined }
    } else if (!wanted && this.hold !== undefined) {
      this.release()
    }
  }

  /** True while the computer is being kept awake. */
  get holding(): boolean {
    return this.hold !== undefined
  }

  private release(): void {
    const hold = this.hold
    this.hold = undefined
    if (hold === undefined) return
    try { this.options.blocker.stop(hold) } catch { /* the hold is gone with the process anyway */ }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.release()
  }
}
