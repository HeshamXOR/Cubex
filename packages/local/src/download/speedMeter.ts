/**
 * Download speed over a short sliding window, so the figure (and the ETA built
 * from it) is steady instead of jumping with every network read. Feed it the
 * cumulative byte count; it reports bytes per second between the oldest and
 * newest sample still inside the window.
 */
export interface SpeedMeterOptions {
  /** How far back samples count. Default 5 s. */
  windowMs?: number
  /** Samples must span at least this long before a speed is reported. Default 500 ms. */
  minSpanMs?: number
  now?: () => number
}

export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = []
  private readonly windowMs: number
  private readonly minSpanMs: number
  private readonly now: () => number

  constructor(options: SpeedMeterOptions = {}) {
    this.windowMs = options.windowMs ?? 5000
    this.minSpanMs = options.minSpanMs ?? 500
    this.now = options.now ?? Date.now
  }

  /** Record the cumulative bytes received so far. A smaller value than before restarts the measurement. */
  add(totalBytes: number): void {
    const t = this.now()
    const last = this.samples[this.samples.length - 1]
    if (last && totalBytes < last.bytes) this.samples = []
    this.samples.push({ t, bytes: totalBytes })
    const cutoff = t - this.windowMs
    // Always keep the two newest samples so one quiet moment does not erase the speed.
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift()
  }

  bytesPerSecond(): number | undefined {
    if (this.samples.length < 2) return undefined
    const first = this.samples[0]!
    const last = this.samples[this.samples.length - 1]!
    const span = last.t - first.t
    if (span < this.minSpanMs) return undefined
    return Math.max(0, (last.bytes - first.bytes) / (span / 1000))
  }

  etaSeconds(remainingBytes: number): number | undefined {
    const speed = this.bytesPerSecond()
    if (!speed || speed <= 0 || remainingBytes <= 0) return undefined
    return remainingBytes / speed
  }
}
