import type { DiagnosticFileCount, DiagnosticItem, DiagnosticsSummary } from './ipc'

/**
 * The one place that decides what a post-edit diagnostics summary may look like once it leaves the checker:
 * the main process validates tool metadata with it before the summary reaches the window, and the saved
 * transcript validates it again, so imported or damaged history can never carry unbounded text.
 */

/** Problems kept with one edit; the model-facing text lists the same number at most. */
export const MAX_SUMMARY_ITEMS = 15
/** Files an edit may carry counts for; apply_patch is capped to this many files as well. */
export const MAX_SUMMARY_FILES = 50
const MAX_PATH_CHARS = 500
const MAX_MESSAGE_CHARS = 300
const MAX_COUNT = 1_000_000
const MAX_POSITION = 100_000_000
const CODE = /^[A-Za-z0-9_.-]{1,32}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

function path(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_CHARS && !value.includes('\0') ? value : undefined
}

function oneLine(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`
}

/** A well-formed problem, or undefined when it cannot be shown honestly (no path, no position, no message). */
export function sanitizeDiagnosticItem(value: unknown): DiagnosticItem | undefined {
  if (!record(value)) return undefined
  const file = path(value.path)
  const line = integer(value.line, 1, MAX_POSITION)
  const col = integer(value.col, 1, MAX_POSITION)
  const message = oneLine(value.message, MAX_MESSAGE_CHARS)
  if (!file || line === undefined || col === undefined || !message) return undefined
  return {
    path: file,
    line,
    col,
    ...(typeof value.code === 'string' && CODE.test(value.code) ? { code: value.code } : {}),
    ...(value.severity === 'warning' ? { severity: 'warning' as const } : {}),
    message
  }
}

function sanitizeFileCount(value: unknown): DiagnosticFileCount | undefined {
  if (!record(value)) return undefined
  const file = path(value.path)
  const errors = integer(value.errors, 0, MAX_COUNT)
  const warnings = integer(value.warnings, 0, MAX_COUNT)
  if (!file || errors === undefined || warnings === undefined || (errors === 0 && warnings === 0)) return undefined
  return { path: file, errors, warnings }
}

/**
 * A summary the UI can trust, or undefined when there is nothing to show. A summary with no errors and no
 * warnings is dropped: an absent value already means "nothing new", so storing zeros would only add noise.
 */
export function sanitizeDiagnosticsSummary(value: unknown): DiagnosticsSummary | undefined {
  if (!record(value)) return undefined
  const errors = integer(value.errors, 0, MAX_COUNT)
  const warnings = integer(value.warnings, 0, MAX_COUNT)
  if (errors === undefined || warnings === undefined || (errors === 0 && warnings === 0)) return undefined
  const items = Array.isArray(value.items)
    ? value.items.slice(0, MAX_SUMMARY_ITEMS).flatMap((item) => sanitizeDiagnosticItem(item) ?? [])
    : []
  const files = Array.isArray(value.files)
    ? value.files.slice(0, MAX_SUMMARY_FILES).flatMap((entry) => sanitizeFileCount(entry) ?? [])
    : []
  return { errors, warnings, ...(items.length ? { items } : {}), ...(files.length ? { files } : {}) }
}
