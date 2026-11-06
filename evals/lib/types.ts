import type { PermissionMode } from '@shared/ipc'

/** One eval task, as read from evals/tasks/<slug>/. */
export interface TaskSpec {
  slug: string
  /** Absolute path of the task folder. */
  dir: string
  title: string
  /** What the person would type. */
  prompt: string
  /** Defaults to `bypass`: nothing in a run may wait for an approval. */
  mode: PermissionMode
  timeoutMs: number
  /** Programs the task needs on PATH (`python`); a task whose program is missing is skipped. */
  requires: string[]
  /** Offer the delegation tool, as a window with agents turned on does. Default off. */
  subagents: boolean
  check: { kind: 'script'; file: string } | { kind: 'command'; command: string }
  /** What the scripted `stub` provider does for this task; see evals/lib/stubProvider.ts. */
  stub: { answer?: string; command?: string }
}

export interface CheckResult {
  passed: boolean
  exitCode: number | null
  /** Combined stdout and stderr of the check, trimmed. */
  output: string
  timedOut?: boolean
}

export interface RunResult {
  task: string
  repeat: number
  passed: boolean
  /** Why the run failed when the check did not decide it: a timeout, a provider error, a crash. */
  failure?: string
  check?: CheckResult
  timedOut: boolean
  /** Model requests the loop made. */
  rounds: number
  toolCalls: { total: number; byName: Record<string, number> }
  /** Tool calls that ended in an error. */
  toolErrors: number
  /** Approvals, questions and plan reviews the runner answered for the agent. */
  interventions: number
  /** Failed provider attempts the gateway retried. */
  retries: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  durationMs: number
  /** Everything the agent said in its last request: the answer, for a question. */
  finalText: string
  /** Files the run added (+), changed (~) or removed (-), relative to the fixture. */
  filesChanged: string[]
  /** Short hash of the system prompt of the first request, to tell runs of different prompts apart. */
  promptHash?: string
  /** Names of the tools the first request offered. */
  toolsOffered?: string[]
  /** Kept workspace, only with CUBEX_EVAL_KEEP=1. */
  workspace?: string
}

export interface RunConfig {
  kind: string
  baseUrl?: string
  model: string
  effort?: string
  repeat: number
  concurrency: number
  tasks: string[]
}
