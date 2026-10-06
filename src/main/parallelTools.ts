import type { ToolPermission, ToolResultPart } from '@core/types'

/**
 * Parallel execution of read-only tool calls.
 *
 * When one model response asks for several auto-allowed read-only operations
 * (reading files, listing, searching, fetching docs), nothing about them depends
 * on each other, so they run side by side instead of paying each other's latency.
 * Everything else keeps the strictly sequential behavior: a call that mutates,
 * needs a prompt, or is a special tool waits for the reads before it and runs alone.
 */

/** Calls in flight at once. Enough to hide network and disk latency without flooding either. */
export const MAX_PARALLEL_TOOLS = 4

/**
 * Read-only tools that may overlap. `web_fetch` appears here but is only
 * overlapped when the call would not ask for approval (checked per call).
 * Mutations, shell commands, delegation, plans, todos and questions never overlap.
 */
export const PARALLEL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'list_files', 'search_files', 'glob_files', 'read_command_output', 'skill', 'web_search', 'web_fetch'
])

/**
 * Whether a call may run beside its neighbours: one of the read-only tools above
 * that the harness runs without asking. `needsApproval` is the caller's verdict
 * for the one tool that only sometimes asks (`web_fetch` for a host nobody has
 * approved yet); a call that would prompt must wait its turn for the human.
 */
export function mayOverlap(name: string, defaultPermission: ToolPermission | undefined, needsApproval: boolean): boolean {
  return PARALLEL_READ_ONLY_TOOLS.has(name) && defaultPermission === 'allow' && !needsApproval
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Placeholder result for a call that holds its place in the batch but has not
 * run: it is replaced when the call finishes, and is what the model sees if the
 * turn is cancelled before the call could start.
 */
export function notRunResult(toolUseId: string): ToolResultPart {
  return { type: 'tool_result', toolUseId, isError: true, content: [{ type: 'text', text: 'This call was cancelled before it ran.' }] }
}

/** Result for a call whose execution threw outside the tool's own error handling. */
export function toolFailureResult(toolUseId: string, error: unknown): ToolResultPart {
  const detail = error instanceof Error ? error.message : String(error)
  return { type: 'tool_result', toolUseId, isError: true, content: [{ type: 'text', text: `Tool error: ${detail}` }] }
}

/**
 * A FIFO concurrency limiter: at most `limit` tasks run at once, the rest start
 * in arrival order as slots free up. A finishing task hands its slot straight to
 * the next waiter, so the cap can never be exceeded between release and resume.
 */
export function createLimiter(limit: number): Limiter {
  const cap = Math.max(1, Math.floor(limit))
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => {
    const next = waiting.shift()
    if (next) next() // the slot passes to the next waiter without being freed
    else active--
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < cap) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      release()
    }
  }
}
