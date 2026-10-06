import type { Diagnostic } from './types'

/**
 * Messages between the main thread (DiagnosticsManager) and the checker worker (tsWorker.ts). Plain JSON-safe
 * data only, because it crosses a worker boundary. The worker answers one request at a time.
 */

/** Passed as workerData when the worker starts. */
export interface WorkerInit {
  /** The workspace root this worker serves. Nothing outside it (plus package folders) is ever read. */
  root: string
  /** A folder to resolve `typescript` from when the workspace has none (the app's own install), if any. */
  fallbackDir?: string
  /**
   * One Int32 cell. The main thread stores the id of a request it no longer wants answered; the worker stops that
   * request, whenever it gets to it, at its next checkpoint. Ids only grow, so a stop never touches a later request.
   */
  cancel: SharedArrayBuffer
}

export type WorkerRequest =
  /** Diagnostics around a mutation. `before` is null for a new (or non-UTF-8) file. */
  | { id: number; kind: 'check'; abs: string; before: string | null; after: string }
  /** The file's diagnostics as it is on disk now. */
  | { id: number; kind: 'current'; abs: string }
  /** Build the workspace project's program ahead of the first check. Answers `ok` with no diagnostics. */
  | { id: number; kind: 'warm' }

export type CheckOutcome =
  | { status: 'ok'; before?: Diagnostic[]; after?: Diagnostic[]; limited?: string }
  /** The file is not part of any TypeScript or JavaScript project here, or the project is not checkable. */
  | { status: 'skipped'; reason: string }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string }

export type WorkerResponse =
  | { kind: 'ready'; version: string; source: 'workspace' | 'app' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'result'; id: number; outcome: CheckOutcome }
