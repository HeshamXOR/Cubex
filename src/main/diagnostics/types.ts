import type { DiagnosticItem, DiagnosticsStatus, DiagnosticsSummary } from '@shared/ipc'

/**
 * Post-edit diagnostics, backend-neutral. Callers (the file tools, ChatService, IPC) only see these
 * types and DiagnosticsManager; a backend (today the TypeScript Language Service in a worker thread,
 * later possibly an LSP client for other languages) implements DiagnosticsBackend and nothing else changes.
 */

export type DiagnosticSeverity = 'error' | 'warning'

/** One diagnostic as a backend reports it. Positions are 1-based; the path is workspace-relative with forward slashes. */
export interface Diagnostic {
  path: string
  line: number
  col: number
  severity: DiagnosticSeverity
  /** The compiler's code, e.g. "TS2322". */
  code?: string
  message: string
  /**
   * Whitespace-collapsed text of the line the diagnostic starts on. It pairs identical errors across an
   * edit so a moved error is not "new"; it is never shown to the model or the user.
   */
  context?: string
}

/** A file a tool just wrote. `before` is the exact prior bytes (empty when the file is new); `after` is null for a deletion. */
export interface MutatedFile {
  abs: string
  before: Buffer
  existed: boolean
  after: string | null
}

/** What the model and the UI get back for one edit. */
export interface DiagnosticsReport {
  /** Text to append to the tool result: "\n\nNew diagnostics (2 errors):\n<lines>"; empty when only warnings are new. */
  text: string
  summary: DiagnosticsSummary & { items: DiagnosticItem[] }
}

/** Appends diagnostics to a tool result. Resolves to undefined when there is nothing trustworthy to say. */
export type DiagnoseHook = (files: MutatedFile[], signal?: AbortSignal) => Promise<DiagnosticsReport | undefined>

/** The state of one file before and after a mutation. `undefined` for a side the checker could not evaluate. */
export interface FileCheck {
  before?: Diagnostic[]
  after?: Diagnostic[]
}

export interface BackendCheckRequest {
  root: string
  abs: string
  /** Prior text; null when the file did not exist or was not valid UTF-8 (no baseline: everything counts as new). */
  before: string | null
  /** New text; null when the file was removed (nothing to check). */
  after: string | null
}

/**
 * One diagnostics engine. Every method is silent on failure: a timeout, a crash or a missing checker
 * resolve to undefined and never to an empty list, so silence is never read as "clean".
 */
export interface DiagnosticsBackend {
  readonly id: string
  /** Cheap and synchronous: could this backend check the file at all (extension and project config present)? */
  handles(root: string, abs: string): boolean
  /** Diagnostics of the file around a mutation. */
  check(request: BackendCheckRequest, signal?: AbortSignal): Promise<FileCheck | undefined>
  /** The file's errors as it is on disk now; undefined when it cannot be checked. */
  current(root: string, abs: string, signal?: AbortSignal): Promise<Diagnostic[] | undefined>
  status(root: string): DiagnosticsStatus
  dispose(): void
}
