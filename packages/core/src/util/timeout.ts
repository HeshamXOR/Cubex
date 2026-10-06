import { NormalizedAIError } from '../types/errors'
import type { TimeoutConfig } from '../types/request'
import { resolveTimeouts, type ResolvedTimeouts } from '../types/timeout'

const MINUTE_MS = 60_000

/** Which of the three limits ran out. */
export type TimeoutKind = 'first-response' | 'silence' | 'overall'

export interface TimeoutReached {
  kind: TimeoutKind
  /** The limit that ran out, in milliseconds. */
  ms: number
}

/** "10 minutes", "90 seconds", "2 hours": a limit as a person reads it. */
export function describeDuration(ms: number): string {
  const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`
  if (ms < 1000) return `${ms} ms`
  if (ms % MINUTE_MS === 0) {
    const minutes = ms / MINUTE_MS
    return minutes >= 120 && minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute')
  }
  if (ms < 2 * MINUTE_MS) return plural(Number((ms / 1000).toFixed(1)), 'second')
  return plural(Number((ms / MINUTE_MS).toFixed(1)), 'minute')
}

// The machine-readable half of the error, so the retry rules can tell these from a timeout an adapter reported itself.
const RAW_CODE: Record<TimeoutKind, string> = {
  'first-response': 'first_response_timeout',
  silence: 'silence_timeout',
  overall: 'overall_timeout'
}

function timeoutMessage({ kind, ms }: TimeoutReached, provider: string): string {
  const wait = describeDuration(ms)
  switch (kind) {
    case 'first-response':
      return `${provider} sent nothing for ${wait}. It may be queued or down. Try again, or pick another model.`
    case 'silence':
      return `${provider} stopped sending data for ${wait}.`
    case 'overall':
      return `The request to ${provider} reached the overall limit of ${wait} that you set in Settings.`
  }
}

/**
 * The error for a limit that ran out. It names which limit and how long, in words a person can act on. The overall
 * limit is permanent: a ceiling the person chose is not something to retry past.
 */
export function timeoutError(reached: TimeoutReached, providerId: string, providerName?: string): NormalizedAIError {
  const overall = reached.kind === 'overall'
  return new NormalizedAIError({
    provider: providerId,
    category: 'TIMEOUT',
    message: timeoutMessage(reached, providerName || providerId),
    classification: overall ? 'permanent' : 'transient',
    retryable: !overall,
    rawCode: RAW_CODE[reached.kind]
  })
}

/** A first-response or silence timeout: waiting that already took minutes, so the gateway retries it once at most. */
export function isWaitTimeout(error: NormalizedAIError): boolean {
  return error.rawCode === RAW_CODE['first-response'] || error.rawCode === RAW_CODE.silence
}

export function isOverallTimeout(error: NormalizedAIError): boolean {
  return error.rawCode === RAW_CODE.overall
}

export interface WatchdogOptions {
  limits: ResolvedTimeouts
  /** When the overall limit runs out, as a `Date.now()` time. Every attempt of one gateway call shares it. */
  deadline?: number
  /** The caller's own signal. Stop always wins over a limit. */
  signal?: AbortSignal
}

/**
 * The clocks for one attempt at a request. It starts waiting for the response to begin; model output moves it to
 * waiting for silence, and every sign of life restarts the clock either way. A request that keeps sending is never
 * ended by the first two, only by the optional overall deadline or by the caller's own signal.
 *
 * Its `signal` goes to the provider, so the real request is aborted and not just abandoned.
 */
export class RequestWatchdog {
  private readonly controller = new AbortController()
  private readonly limits: ResolvedTimeouts
  private readonly external: AbortSignal | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private overallTimer: ReturnType<typeof setTimeout> | undefined
  private streaming = false
  private paused = false
  private done = false
  private reachedLimit: TimeoutReached | undefined
  private readonly onExternalAbort = (): void => {
    this.clearTimers()
    this.controller.abort(this.external?.reason)
  }

  constructor({ limits, deadline, signal }: WatchdogOptions) {
    this.limits = limits
    this.external = signal
    if (signal?.aborted) {
      this.done = true
      this.controller.abort(signal.reason)
      return
    }
    signal?.addEventListener('abort', this.onExternalAbort, { once: true })
    if (deadline !== undefined) this.overallTimer = setTimeout(() => this.reach('overall'), Math.max(0, deadline - Date.now()))
    this.arm()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** The limit that stopped the request, if one did. Undefined when the caller stopped it or nothing did. */
  get reached(): TimeoutReached | undefined {
    return this.reachedLimit
  }

  /** The provider was heard from. Model output ends the wait for the response to begin; any activity restarts the clock. */
  activity(output = false): void {
    if (this.done || this.reachedLimit) return
    if (output) this.streaming = true
    if (!this.paused) this.arm()
  }

  /** The consumer is busy with an event. Its time is not the provider's silence, so the clock stands still. */
  pause(): void {
    this.paused = true
    this.clearIdle()
  }

  resume(): void {
    this.paused = false
    this.arm()
  }

  /** Release the timers and the caller's signal. Safe to call more than once. */
  dispose(): void {
    this.done = true
    this.clearTimers()
    this.external?.removeEventListener('abort', this.onExternalAbort)
  }

  private arm(): void {
    this.clearIdle()
    if (this.done || this.reachedLimit) return
    const kind: TimeoutKind = this.streaming ? 'silence' : 'first-response'
    const ms = this.streaming ? this.limits.silenceMs : this.limits.firstResponseMs
    if (ms > 0) this.idleTimer = setTimeout(() => this.reach(kind), ms)
  }

  private reach(kind: TimeoutKind): void {
    if (this.done || this.reachedLimit || this.controller.signal.aborted) return
    const ms = kind === 'overall' ? this.limits.overallMs : kind === 'silence' ? this.limits.silenceMs : this.limits.firstResponseMs
    this.reachedLimit = { kind, ms }
    this.clearTimers()
    // The name makes an adapter that surfaces the reason classify it as a timeout; the gateway words the real error.
    this.controller.abort(new DOMException(`Stopped at the ${kind} limit of ${describeDuration(ms)}`, 'TimeoutError'))
  }

  private clearIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private clearTimers(): void {
    this.clearIdle()
    clearTimeout(this.overallTimer)
    this.overallTimer = undefined
  }
}

/**
 * The signal an adapter hands its HTTP request: the caller's, plus the explicit overall limit (`totalMs`) when a direct
 * caller sets one. Through the gateway there is nothing to add: it enforces every limit itself, so one clock decides
 * and the error says which limit was reached.
 */
export function withTimeout(
  config: TimeoutConfig | undefined,
  external?: AbortSignal
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort(external?.reason)
  let listening = false
  let timer: ReturnType<typeof setTimeout> | undefined

  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else {
      external.addEventListener('abort', onExternalAbort, { once: true })
      listening = true
    }
  }

  const { overallMs } = resolveTimeouts(config)
  if (overallMs > 0) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(`The request reached the overall limit of ${describeDuration(overallMs)}`, 'TimeoutError'))
      }
    }, overallMs)
  }

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      if (listening) {
        external?.removeEventListener('abort', onExternalAbort)
        listening = false
      }
    }
  }
}
