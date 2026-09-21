import { NormalizedAIError } from '../types/errors'
import type { TimeoutConfig } from '../types/request'

/**
 * Combine an external abort signal with timeout-based aborts. Returns a signal
 * and a `clear()` to release timers. Used by adapters to enforce request/total
 * timeouts and by the gateway for the overall deadline.
 */
export function withTimeout(
  config: TimeoutConfig | undefined,
  external?: AbortSignal
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timers: ReturnType<typeof setTimeout>[] = []

  const abortWith = (reason: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException(reason, 'TimeoutError'))
    }
  }

  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', () => controller.abort(external.reason), { once: true })
  }

  const total = config?.totalMs ?? config?.requestMs
  if (total && total > 0) {
    timers.push(setTimeout(() => abortWith(`Request timed out after ${total}ms`), total))
  }

  return {
    signal: controller.signal,
    clear: () => timers.forEach(clearTimeout)
  }
}

/**
 * Wrap an async iterator so it aborts if no chunk arrives within `idleMs`.
 * Throws a normalized STREAM_ERROR/TIMEOUT on stall.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number | undefined,
  provider: string
): AsyncGenerator<T> {
  if (!idleMs || idleMs <= 0) {
    yield* source
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new NormalizedAIError({
            provider,
            category: 'TIMEOUT',
            message: `Stream idle for more than ${idleMs}ms`,
            classification: 'transient',
            retryable: true
          })
        )
      }, idleMs)
    })
    try {
      const result = await Promise.race([iterator.next(), timeout])
      if (result.done) return
      yield result.value
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
