/**
 * Rate-limits a stream of progress events. The first event goes out at once, a
 * burst is coalesced so only the latest value is delivered when the interval has
 * passed, and the terminal event (`done: true`) is always delivered immediately
 * and exactly once: anything pushed after it is dropped.
 */
export interface ProgressThrottle<T> {
  push(value: T): void
  /** Deliver the pending value now, if there is one. */
  flush(): void
  /** Drop any pending value and stop the timer. */
  cancel(): void
}

export interface ProgressThrottleOptions {
  /** Minimum gap between delivered events. Default 250 ms (about four per second). */
  minIntervalMs?: number
}

export function createProgressThrottle<T extends { done?: boolean }>(
  emit: (value: T) => void,
  options: ProgressThrottleOptions = {}
): ProgressThrottle<T> {
  const minIntervalMs = options.minIntervalMs ?? 250
  let lastEmitAt = Number.NEGATIVE_INFINITY
  let pending: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const stopTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const deliver = (value: T): void => {
    lastEmitAt = Date.now()
    emit(value)
  }

  return {
    push(value) {
      if (closed) return
      if (value.done) {
        closed = true
        stopTimer()
        pending = undefined
        deliver(value)
        return
      }
      const wait = lastEmitAt + minIntervalMs - Date.now()
      if (wait <= 0) {
        stopTimer()
        pending = undefined
        deliver(value)
        return
      }
      pending = value
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined
          const next = pending
          pending = undefined
          if (next !== undefined && !closed) deliver(next)
        }, wait)
        timer.unref?.()
      }
    },
    flush() {
      stopTimer()
      const next = pending
      pending = undefined
      if (next !== undefined && !closed) deliver(next)
    },
    cancel() {
      stopTimer()
      pending = undefined
    }
  }
}
