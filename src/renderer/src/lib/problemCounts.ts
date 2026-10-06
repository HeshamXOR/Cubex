import type { DiagnosticItem, DiagnosticsSummary } from '../../../shared/ipc'
import { plural } from './format'

export interface ProblemCounts {
  errors: number
  warnings: number
}

/** Files the checker can look at; the same extensions the main process hands to the compiler. */
const CHECKED = /\.(?:[cm]?[jt]s|[jt]sx)$/i

export function isCheckedPath(path: string): boolean {
  return CHECKED.test(path)
}

export function countProblems(items: readonly DiagnosticItem[]): ProblemCounts {
  const warnings = items.filter((item) => item.severity === 'warning').length
  return { errors: items.length - warnings, warnings }
}

/** "2 errors", "1 warning", "2 errors, 1 warning". Empty when there is nothing to count. */
export function describeProblems({ errors, warnings }: ProblemCounts): string {
  return [errors > 0 ? plural(errors, 'error') : '', warnings > 0 ? plural(warnings, 'warning') : ''].filter(Boolean).join(', ')
}

/**
 * What one file of an edit introduced. A call that changed one file reports for that file. A multi-file call (a
 * patch) reports counts per file; data without them falls back to the problems listed for the path.
 */
export function diagnosticsForFile(summary: DiagnosticsSummary | undefined, path: string, multiFile: boolean): DiagnosticsSummary | undefined {
  if (!summary) return undefined
  if (!multiFile) return summary
  const items = summary.items?.filter((item) => item.path === path)
  const count = summary.files?.find((file) => file.path === path)
  if (count) return { errors: count.errors, warnings: count.warnings, ...(items?.length ? { items } : {}) }
  const listed = items ? countProblems(items) : { errors: 0, warnings: 0 }
  return listed.errors + listed.warnings > 0 ? { ...listed, items } : undefined
}
