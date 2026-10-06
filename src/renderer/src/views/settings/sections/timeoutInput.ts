import { MAX_TIMEOUT_MS } from '@core/types'

const MINUTE_MS = 60_000

/** The most minutes a limit field takes: a day. */
export const MAX_LIMIT_MINUTES = MAX_TIMEOUT_MS / MINUTE_MS

export type MinutesResult = { ok: true; ms: number } | { ok: false; reason: 'invalid' | 'small' | 'large' }

/**
 * Whole minutes as typed into a limit field, as milliseconds. A limit that must be set refuses 0 and an empty field;
 * the overall limit (`allowNone`) reads both as "no limit".
 */
export function parseMinutes(text: string, allowNone: boolean): MinutesResult {
  const trimmed = text.trim()
  if (trimmed === '') return allowNone ? { ok: true, ms: 0 } : { ok: false, reason: 'invalid' }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'invalid' }
  const minutes = Number(trimmed)
  if (minutes === 0) return allowNone ? { ok: true, ms: 0 } : { ok: false, reason: 'small' }
  if (minutes > MAX_LIMIT_MINUTES) return { ok: false, reason: 'large' }
  return { ok: true, ms: minutes * MINUTE_MS }
}

/** What a field shows for a stored limit: its minutes (with a fraction only when it is not whole), nothing when it is off. */
export function minutesText(ms: number): string {
  return ms > 0 ? String(Number((ms / MINUTE_MS).toFixed(2))) : ''
}

/** Why a limit field was refused, and what to type instead. */
export function minutesProblem(reason: 'invalid' | 'small' | 'large', allowNone: boolean): string {
  if (reason === 'large') return `The most you can set is ${MAX_LIMIT_MINUTES} minutes, which is a day.`
  return allowNone
    ? `Enter a whole number of minutes, from 1 to ${MAX_LIMIT_MINUTES}. Leave it empty or enter 0 for no limit.`
    : `Enter a whole number of minutes, from 1 to ${MAX_LIMIT_MINUTES}.`
}
