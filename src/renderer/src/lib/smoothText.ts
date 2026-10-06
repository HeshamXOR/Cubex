import { advanceReveal, wordBoundary } from './markdownStream'

/**
 * Pacing for text that arrives in network bursts but should read as a steady
 * flow. The reveal speed follows the speed the text is arriving at, plus a
 * share of whatever backlog has built up, and changes gradually so the eye
 * never sees it speed up or stall. Time is passed in, so it is testable
 * without a clock.
 */
export interface SmootherState {
  /** Characters revealed so far. */
  shown: number
  /** Fractional characters owed to the next step. Negative after finishing a word early. */
  carry: number
  /** Current reveal speed, characters per second. */
  rate: number
  /** Smoothed speed the text is arriving at, characters per second. */
  input: number
  /** Length of the text the last time it grew. */
  seen: number
  /** When it last grew, in milliseconds. */
  seenAt: number
  /** Time of the previous step, in milliseconds. */
  at: number
}

/** Slowest reveal while anything is waiting; keeps the tail of a burst from crawling. */
const FLOOR_CPS = 28
/** The backlog drains with about this time constant while text is still arriving. */
const CATCH_UP_S = 0.6
/** Past this many hidden characters the reveal speeds up hard (a tab came back, a paste landed). */
const BIG_BACKLOG = 1200
/** If nothing arrives for this long, a half-received last word is shown anyway. */
const STALL_MS = 450
/** Once the text is final the remainder is shown within about this time. */
const FLUSH_S = 0.28
/** How quickly the reveal speed itself may change. */
const INERTIA_S = 0.14

export function createSmoother(shown: number, length: number, now: number): SmootherState {
  return { shown, carry: 0, rate: 0, input: 0, seen: length, seenAt: now, at: now }
}

/**
 * Advance the reveal to time `now`. Returns true while another step is needed:
 * text is still hidden, or more may still arrive.
 */
export function stepSmoother(st: SmootherState, text: string, now: number, live: boolean): boolean {
  const dt = Math.min(0.1, Math.max(0.001, (now - st.at) / 1000))
  st.at = now

  if (text.length < st.seen) {
    // The text was rewritten shorter (tool markup stripped, message replaced).
    st.seen = text.length
    st.shown = Math.min(st.shown, text.length)
  } else if (text.length > st.seen) {
    const span = Math.max(0.03, (now - st.seenAt) / 1000)
    st.input += ((text.length - st.seen) / span - st.input) * 0.4
    st.seen = text.length
    st.seenAt = now
  } else if (now - st.seenAt > 600) {
    st.input *= Math.exp(-dt)
  }

  // A word is shown only once it is whole, unless the stream seems to have paused.
  const stalled = now - st.seenAt > STALL_MS
  const limit = !live || stalled ? text.length : wordBoundary(text)
  const backlog = limit - st.shown
  if (backlog <= 0) {
    st.carry = 0
    return live || st.shown < text.length
  }

  let desired = live ? st.input + backlog / CATCH_UP_S : backlog / FLUSH_S
  if (backlog > BIG_BACKLOG) desired = Math.max(desired, backlog / 0.35)
  desired = Math.max(desired, FLOOR_CPS)
  st.rate = st.rate === 0 ? desired : st.rate + (desired - st.rate) * (1 - Math.exp(-dt / INERTIA_S))

  st.carry += st.rate * dt
  if (st.carry >= 1) {
    const next = advanceReveal(text, st.shown, st.carry, limit)
    // Finishing a word borrows against the next frames, so the average speed holds.
    st.carry = Math.max(st.carry - (next - st.shown), -st.rate * 0.25)
    st.shown = next
  }
  return live || st.shown < text.length
}
