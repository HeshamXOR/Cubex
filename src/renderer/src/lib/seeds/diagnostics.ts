import type { DiagnosticItem, DiagnosticsStatus, DiagnosticsSummary } from '../../../../shared/ipc'
import type { AppSettings } from '../../../../shared/settings'
import type { PreviewSeed } from './index'

/**
 * Compiler problems for the browser preview (`?seed=1&done=1&review=1&diagnostics=1`). The value picks a variant:
 *   1         the story's files: backoff.ts is clean, client.ts has two errors and a warning, client.test.ts a warning
 *   errors    client.ts and client.test.ts have errors and no warnings
 *   clean     no problems anywhere
 *   nots      the folder has no TypeScript, so edits are not checked
 *   noconfig  the folder has no tsconfig.json or jsconfig.json
 *   slow      the live list answers after six seconds
 *   broken    the live list cannot be loaded
 *
 * The edit rows in the thread carry what each edit introduced, which here matches what the files have now. Only
 * errors are listed with an edit, as the main process does; warnings are counted.
 */

const BACKOFF = 'src/upload/backoff.ts'
const CLIENT = 'src/upload/client.ts'
const TEST = 'src/upload/client.test.ts'

/** The tool call that edited each file in the seeded thread. */
const EDITED_BY: Record<string, string> = { t5: BACKOFF, t6: CLIENT, t7: TEST }

const LONG_MESSAGE = "Argument of type '{ headers: Headers; retries: number; baseMs: number; onRetry: (attempt: number, error: UploadError) => void; }' is not assignable to parameter of type 'BackoffOptions'. Object literal may only specify known properties, and 'headers' does not exist in type 'BackoffOptions'."

const clientErrors: DiagnosticItem[] = [
  { path: CLIENT, line: 41, col: 18, code: 'TS2345', message: LONG_MESSAGE },
  { path: CLIENT, line: 58, col: 7, code: 'TS2322', message: "Type 'Promise<Response | undefined>' is not assignable to type 'Promise<Response>'." }
]

type Problems = Record<string, DiagnosticItem[]>

const MIXED: Problems = {
  [BACKOFF]: [],
  [CLIENT]: [...clientErrors, { path: CLIENT, line: 63, col: 10, code: 'TS6385', severity: 'warning', message: "'retryAfter' is deprecated. Use parseRetryAfter from './backoff' instead." }],
  [TEST]: [{ path: TEST, line: 6, col: 22, code: 'TS6385', severity: 'warning', message: "'reply' is deprecated. Use makeReply from '../testing' instead." }]
}

const ERRORS_ONLY: Problems = {
  [BACKOFF]: [],
  [CLIENT]: clientErrors,
  [TEST]: [{ path: TEST, line: 18, col: 36, code: 'TS2554', message: 'Expected 1 arguments, but got 2.' }]
}

const NONE: Problems = { [BACKOFF]: [], [CLIENT]: [], [TEST]: [] }

const NO_TYPESCRIPT = 'TypeScript was not found for this folder, so errors are not checked after edits. Run npm install -D typescript in the project to turn it on.'
const NO_CONFIG = 'This folder has no tsconfig.json or jsconfig.json, so errors are not checked after edits. Add a tsconfig.json to this folder to turn it on.'

function problemsFor(variant: string): Problems {
  if (variant === 'errors') return ERRORS_ONLY
  if (variant === 'clean' || variant === 'nots' || variant === 'noconfig') return NONE
  return MIXED
}

function statusFor(variant: string): DiagnosticsStatus {
  if (variant === 'nots') return { available: false, reason: NO_TYPESCRIPT }
  if (variant === 'noconfig') return { available: false, reason: NO_CONFIG }
  return { available: true, engine: 'typescript', version: '5.7.3' }
}

function summaryOf(items: readonly DiagnosticItem[]): DiagnosticsSummary | undefined {
  const errors = items.filter((item) => item.severity !== 'warning')
  const warnings = items.length - errors.length
  return errors.length + warnings === 0 ? undefined : { errors: errors.length, warnings, ...(errors.length ? { items: errors.map((item) => ({ ...item })) } : {}) }
}

/** What the edit made by seeded tool call `toolId` introduced, for the thread. Nothing unless `?diagnostics` is on. */
export function seedDiagnostics(toolId: string): { diagnostics?: DiagnosticsSummary } {
  if (typeof location === 'undefined') return {}
  const variant = new URLSearchParams(location.search).get('diagnostics')
  const path = EDITED_BY[toolId]
  const diagnostics = variant !== null && path ? summaryOf(problemsFor(variant)[path] ?? []) : undefined
  return diagnostics ? { diagnostics } : {}
}

export const seed: PreviewSeed = {
  api: (flags) => {
    const variant = flags.get('diagnostics')
    if (variant === null) return {}
    const problems = problemsFor(variant)
    let saved: Partial<AppSettings> = {}
    return {
      getDiagnostics: async (_conversationId, path) => {
        if (variant === 'slow') await new Promise((resolve) => setTimeout(resolve, 6000))
        if (variant === 'broken') throw new Error('The type checker did not answer.')
        return (path ? problems[path] ?? [] : Object.values(problems).flat()).map((item) => ({ ...item }))
      },
      getDiagnosticsStatus: async () => statusFor(variant),
      // The preview keeps what the Type checking toggle saves, so both states can be tried.
      updateSettings: async (patch) => {
        const { api } = await import('../api')
        saved = { ...saved, ...patch }
        return { ...(await api.getSettings()), ...saved }
      }
    }
  }
}
