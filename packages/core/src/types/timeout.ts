import type { TimeoutConfig } from './request'

const MINUTE_MS = 60_000

/** How long to wait for a response to begin. The OpenAI and Anthropic SDKs default to the same ten minutes. */
export const DEFAULT_FIRST_RESPONSE_MS = 10 * MINUTE_MS
/** How long a response that has begun may go quiet. Reasoning models can think without sending anything for minutes. */
export const DEFAULT_SILENCE_MS = 5 * MINUTE_MS
/** The longest a limit can be: a day. A timer past 2^31 ms (about 24.8 days) would fire at once. */
export const MAX_TIMEOUT_MS = 24 * 60 * MINUTE_MS

/** What an install uses until the person changes it. `totalMs: 0` is no overall limit. */
export const DEFAULT_TIMEOUT_CONFIG: Readonly<TimeoutConfig> = Object.freeze({
  requestMs: DEFAULT_FIRST_RESPONSE_MS,
  streamIdleMs: DEFAULT_SILENCE_MS,
  totalMs: 0
})

/** The three limits as the gateway applies them. Always finite and in range, so nothing downstream re-checks them. */
export interface ResolvedTimeouts {
  /** The longest wait for the response to begin. 0 means no limit. */
  firstResponseMs: number
  /** The longest silence once the response has begun. 0 means no limit. */
  silenceMs: number
  /** A hard ceiling on one request. 0 means none. */
  overallMs: number
}

/** A usable limit: 0 turns it off, anything that is not a finite non-negative number takes the fallback, and a day is the most. */
function limit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value === 0 ? 0 : Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(value)))
}

/** Settings and renderer requests are untrusted, so every reader of a `TimeoutConfig` goes through here. */
export function resolveTimeouts(config?: TimeoutConfig): ResolvedTimeouts {
  return {
    firstResponseMs: limit(config?.requestMs, DEFAULT_FIRST_RESPONSE_MS),
    silenceMs: limit(config?.streamIdleMs, DEFAULT_SILENCE_MS),
    overallMs: limit(config?.totalMs, 0)
  }
}

/** `ai.timeout` in the shape it is stored in: all three keys present and in range. */
export function normalizeTimeoutConfig(value: unknown): TimeoutConfig {
  const { firstResponseMs, silenceMs, overallMs } = resolveTimeouts(
    typeof value === 'object' && value !== null ? (value as TimeoutConfig) : undefined
  )
  return { requestMs: firstResponseMs, streamIdleMs: silenceMs, totalMs: overallMs }
}

/**
 * The `timeout` to give an SDK client. It bounds the wait for response headers and doubles as the socket's idle limit,
 * so it must not undercut either of the gateway's limits. With one of them off it is as long as a limit can be.
 */
export function sdkTimeoutMs(config?: TimeoutConfig): number {
  const { firstResponseMs, silenceMs } = resolveTimeouts(config)
  return firstResponseMs === 0 || silenceMs === 0 ? MAX_TIMEOUT_MS : Math.max(firstResponseMs, silenceMs)
}
