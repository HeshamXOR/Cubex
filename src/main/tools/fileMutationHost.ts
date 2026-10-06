import type { ToolResult } from '@core/types'
import { condenseDiff, lineDiff, serializeDiff } from '@core/tools/lineDiff'
import type { FileObservation, FileObservations } from './fileObservations'

/**
 * The read-before-edit machinery of one createFileTools() instance, handed to the
 * multi-edit and patch tools so they follow exactly the same ledger, path-guard
 * and checkpoint rules as edit_file and write_file.
 */
export interface FileMutationHost {
  root: string
  observations: FileObservations
  /** Resolve a workspace path, throwing when it escapes the workspace. */
  resolvePath(path: string): string
  /** Canonical ledger/lock key for a path (stable across short-name aliases and case on Windows). */
  observationKey(abs: string): string
  requireCurrent(key: string, version: string, full?: boolean): FileObservation
  readForMutation(abs: string, signal?: AbortSignal): Promise<{ bytes: Buffer; text?: string; version: string }>
  verifyBeforeMutation(abs: string, version: string, signal?: AbortSignal): Promise<void>
  /** Confirm the bytes on disk are exactly `expected` and return the file's new version. */
  recordWritten(abs: string, key: string, expected: string, signal?: AbortSignal): Promise<string>
  atomicReplace(abs: string, data: string | Buffer): Promise<void>
  onMutate?: (absPath: string, before: Buffer, existed: boolean, after?: Buffer | null) => void
}

export const MUTATION_LIMIT_BYTES = 32 * 1024 * 1024

export function toolOk(content: string): ToolResult {
  return { toolUseId: '', content }
}

export function toolFail(content: string): ToolResult {
  return { toolUseId: '', content, isError: true }
}

export interface DiffSummary {
  added: number
  removed: number
  /** Condensed inline diff in ToolActivity.diff format (one line per entry, tag first). */
  diff: string
}

/** Line counts plus the condensed, serialized diff for an edit's before/after text. */
export function summarizeDiff(before: string, after: string): DiffSummary {
  // One final newline terminates the last line; it is not an extra empty line to count.
  const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text)
  const full = lineDiff(withoutFinalNewline(before), withoutFinalNewline(after))
  return {
    added: full.filter((line) => line.tag === '+').length,
    removed: full.filter((line) => line.tag === '-').length,
    diff: serializeDiff(condenseDiff(full, 3).slice(0, 200))
  }
}

/** The «diff …» markers the chat loop parses (and hides from the model) after a mutation. */
export function diffMarker(summary: DiffSummary): string {
  return `«diff added=${summary.added} removed=${summary.removed}»«diffbody:${Buffer.from(summary.diff, 'utf8').toString('base64')}»`
}

/** Totals only, for multi-file results whose per-file diffs travel as metadata. */
export function diffTotalsMarker(added: number, removed: number): string {
  return `«diff added=${added} removed=${removed}»`
}
