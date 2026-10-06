import type { DiagnosticItem, DiagnosticsStatus } from '@shared/ipc'
import type { DiagnosticsManager } from './DiagnosticsManager'
import { sourceKind } from './paths'

/** Why nothing is checked while the setting is off; the Settings group and every problems list show it as is. */
export const CHECKS_OFF_REASON = 'Checking edits for type errors is turned off. Turn it on in Settings.'
export const NO_FOLDER_REASON = 'Choose a project folder to check edits for type errors.'

const MAX_PATH_CHARS = 4096
/** Files a Problems list without a path looks at, and the problems it returns. */
const MAX_FILES = 40
const MAX_ITEMS = 500
const LIST_BUDGET_MS = 15_000

export interface DiagnosticsHandlerDeps {
  /** Validates a renderer-supplied task id; throws for anything that is not a bounded string. */
  taskId: (value: unknown) => string
  /** Whether checks are turned on in Settings. Asked on every call. */
  enabled: () => boolean
  /** The folder a task works in (the selected folder when no id is given). Throws for a task that does not exist. */
  workspaceOf: (conversationId?: string) => string | undefined
  /** Workspace-relative paths of the files the task changed and still has. */
  changedFiles: (conversationId: string) => Promise<string[]>
  /**
   * The absolute path of a file inside the workspace. Throws when the path escapes the workspace (a mistake or an
   * attack) and answers undefined when the file is simply not there.
   */
  inWorkspace: (workspace: string, path: string) => string | undefined
  /** Created on first use: asking about a folder that cannot be checked must not start anything. */
  manager: () => Pick<DiagnosticsManager, 'getDiagnostics' | 'status' | 'lastRoot'>
}

function optionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PATH_CHARS || value.includes('\0')) throw new Error('Invalid file path.')
  return value
}

/**
 * The two diagnostics channels. Both take untrusted renderer input. A checker that cannot answer is never an error
 * here: problems come back as an empty list and `status` says why, so a Problems list can explain itself.
 */
export function createDiagnosticsHandlers(deps: DiagnosticsHandlerDeps) {
  return {
    /** Current problems in one file of the task's workspace, or in every file the task changed. */
    async get(conversationId: unknown, path?: unknown): Promise<DiagnosticItem[]> {
      const id = deps.taskId(conversationId)
      const relative = optionalPath(path)
      if (!deps.enabled()) return []
      const workspace = deps.workspaceOf(id)
      if (!workspace) return []
      const manager = deps.manager()

      try {
        if (relative !== undefined) {
          const abs = deps.inWorkspace(workspace, relative)
          return abs === undefined ? [] : await manager.getDiagnostics(workspace, abs, AbortSignal.timeout(LIST_BUDGET_MS))
        }

        const signal = AbortSignal.timeout(LIST_BUDGET_MS)
        const items: DiagnosticItem[] = []
        const files = (await deps.changedFiles(id)).filter((file) => sourceKind(file) !== undefined).slice(0, MAX_FILES)
        for (const file of files) {
          if (signal.aborted || items.length >= MAX_ITEMS) break
          let abs: string | undefined
          try { abs = deps.inWorkspace(workspace, file) } catch { continue }
          if (abs !== undefined) items.push(...await manager.getDiagnostics(workspace, abs, signal))
        }
        return items.slice(0, MAX_ITEMS)
      } catch (error) {
        // A path that leaves the workspace is the caller's mistake and is reported as one; nothing else is.
        if (error instanceof Error && /escapes the workspace/i.test(error.message)) throw error
        return []
      }
    },

    /** Whether edits can be checked for this task's workspace (the last one used when no task is named), and why not. */
    status(conversationId?: unknown): DiagnosticsStatus {
      const id = conversationId === undefined || conversationId === null ? undefined : deps.taskId(conversationId)
      if (!deps.enabled()) return { available: false, engine: 'typescript', reason: CHECKS_OFF_REASON }
      const workspace = deps.workspaceOf(id) ?? (id === undefined ? deps.manager().lastRoot : undefined)
      if (!workspace) return { available: false, engine: 'typescript', reason: NO_FOLDER_REASON }
      return deps.manager().status(workspace)
    }
  }
}
