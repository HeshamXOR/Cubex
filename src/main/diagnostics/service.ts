import { DiagnosticsManager } from './DiagnosticsManager'
import type { DiagnoseHook } from './types'

let shared: DiagnosticsManager | undefined

/** The app's single DiagnosticsManager, created when something first asks for it. */
export function sharedDiagnostics(): DiagnosticsManager {
  shared ??= new DiagnosticsManager()
  return shared
}

/** Stop every checker worker. The next sharedDiagnostics() call starts a fresh manager. */
export function disposeSharedDiagnostics(): void {
  shared?.dispose()
  shared = undefined
}

/** The part of the manager the hook needs; narrow so a test can supply a stand-in. */
type HookSource = Pick<DiagnosticsManager, 'createDiagnoseHook' | 'warm'>

/**
 * The hook a task's file tools call after every write. `enabled` is asked on each call, never remembered, so
 * turning the setting off stops checks at once and turning it on starts them with no restart. While it is off the
 * manager is not touched at all: no worker starts and nothing is read.
 *
 * Creating the hook for an enabled task also warms the workspace's checker, so the first edit of the turn finds
 * the program already built instead of waiting for it.
 */
export function afterEditDiagnoseHook(root: string, enabled: () => boolean, manager: () => HookSource = sharedDiagnostics): DiagnoseHook {
  if (enabled()) manager().warm(root)
  return async (files, signal) => {
    if (!enabled()) return undefined
    return manager().createDiagnoseHook(root)(files, signal)
  }
}
