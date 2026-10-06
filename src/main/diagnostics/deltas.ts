import type { DiagnosticFileCount, DiagnosticItem } from '@shared/ipc'
import type { Diagnostic, DiagnosticsReport } from './types'

/** Errors listed for one file in the text the model reads. */
export const MAX_ERRORS_PER_FILE = 5
/** Errors listed across all files of one tool call (a multi-file patch). */
export const MAX_ERRORS_TOTAL = 15
const MAX_MESSAGE_CHARS = 300
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g

/** Whitespace-collapsed text with control characters removed; the form used for comparing and for display. */
function collapse(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Identity of a diagnostic that survives edits above it: the code and the normalized message, never the
 * line or column. Two errors with one key are interchangeable; see newDiagnostics for how duplicates pair up.
 */
export function diagnosticKey(d: Pick<Diagnostic, 'code' | 'message'>): string {
  return `${d.code ?? ''}|${collapse(d.message)}`
}

function groupByKey(list: readonly Diagnostic[]): Map<string, Diagnostic[]> {
  const groups = new Map<string, Diagnostic[]>()
  for (const d of list) {
    const key = diagnosticKey(d)
    const bucket = groups.get(key)
    if (bucket) bucket.push(d)
    else groups.set(key, [d])
  }
  return groups
}

/**
 * The diagnostics in `after` that `before` did not already have. Matching is a multiset difference on
 * diagnosticKey, so an error that only moved to another line is not new, while a second identical error is.
 * Among duplicates, ones on unchanged source text pair first, so the error reported as new is the one the
 * edit actually introduced. Results keep `after` order.
 */
export function newDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
  const pool = groupByKey(before)
  const unpaired: Diagnostic[] = []
  for (const d of after) {
    const bucket = pool.get(diagnosticKey(d))
    const same = bucket && d.context !== undefined ? bucket.findIndex((old) => old.context === d.context) : -1
    if (bucket && same >= 0) bucket.splice(same, 1)
    else unpaired.push(d)
  }
  return unpaired.filter((d) => {
    const bucket = pool.get(diagnosticKey(d))
    if (bucket && bucket.length > 0) {
      bucket.shift()
      return false
    }
    return true
  })
}

/** One line of text for the model: single line, no control characters, bounded. */
function oneLine(message: string): string {
  const text = collapse(message)
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS - 3).trimEnd()}...`
}

/** `src/a.ts:12:5 error TS2322: Type 'string' is not assignable to type 'number'.` */
export function formatDiagnosticLine(d: Diagnostic): string {
  const label = d.code ? `${d.severity} ${d.code}` : d.severity
  return `${d.path}:${d.line}:${d.col} ${label}: ${oneLine(d.message)}`
}

function byPosition(a: Diagnostic, b: Diagnostic): number {
  return a.line - b.line || a.col - b.col
}

function toItem(d: Diagnostic): DiagnosticItem {
  return { path: d.path, line: d.line, col: d.col, ...(d.code ? { code: d.code } : {}), message: oneLine(d.message) }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Turn the new diagnostics of each mutated file (one array per file, in file order) into the block appended to
 * the tool result plus the metadata for the UI. Only errors are listed. Returns undefined when nothing is new:
 * the caller then leaves the result untouched, because absence of text must never be read as "checked and clean".
 */
export function buildReport(perFile: readonly (readonly Diagnostic[])[]): DiagnosticsReport | undefined {
  let errors = 0
  let warnings = 0
  const shown: Diagnostic[] = []
  const files: DiagnosticFileCount[] = []
  for (const list of perFile) {
    const fileErrors = list.filter((d) => d.severity === 'error').sort(byPosition)
    errors += fileErrors.length
    warnings += list.length - fileErrors.length
    shown.push(...fileErrors.slice(0, MAX_ERRORS_PER_FILE))
    // A patch that changed several files tells the window which of them each problem belongs to.
    if (perFile.length > 1 && list.length > 0) files.push({ path: list[0]!.path, errors: fileErrors.length, warnings: list.length - fileErrors.length })
  }
  if (errors === 0 && warnings === 0) return undefined
  const items = shown.slice(0, MAX_ERRORS_TOTAL)
  const hidden = errors - items.length
  const text = errors === 0 ? '' : [
    `\n\nNew diagnostics (${plural(errors, 'error')}):`,
    ...items.map(formatDiagnosticLine),
    ...(hidden > 0 ? [`... and ${plural(hidden, 'more error')} not shown.`] : [])
  ].join('\n')
  return { text, summary: { errors, warnings, items: items.map(toItem), ...(files.length ? { files } : {}) } }
}
