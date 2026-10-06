import { IPC } from '@shared/ipc'
import { validateHookTestRequest, type HookTestResult } from '@shared/policy'
import { testHook } from '../hooks'
import type { IpcContext } from './context'

/** A test runs the user's command for up to ten seconds; a few at once is plenty. */
const MAX_TESTS_AT_ONCE = 3

export function register(ctx: IpcContext): void {
  let running = 0

  // The request is a hook as typed on the page. It runs in the selected project, or in an empty
  // temporary folder when none is selected, and the result says which.
  ctx.handle(IPC.hooksTest, async (request: unknown): Promise<HookTestResult> => {
    const parsed = validateHookTestRequest(request)
    if (!parsed.ok) throw new Error(parsed.error)
    if (running >= MAX_TESTS_AT_ONCE) throw new Error('Other hook tests are still running. Wait for one to finish, then test again.')
    running++
    try {
      return await testHook(parsed.value, { workspace: ctx.taskWorkspace() })
    } finally {
      running--
    }
  })
}
