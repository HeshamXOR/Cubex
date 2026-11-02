import { redactString } from '@core/redaction'
import { childEnvironment } from '../childEnv'
import { resolveShell, type ShellPreference } from '../shell/shellProvider'
import { spawnShell } from '../shell/spawnShell'
import { terminateShellTree } from '../tools/shellProcess'

/** A check is a build or a test run: minutes are normal, so it is cut only when it is plainly stuck. */
export const CHECK_TIMEOUT_MS = 10 * 60_000
/** How much of what a check prints is kept: the end, where a test run puts its failures and its summary. */
export const CHECK_OUTPUT_CAP = 64 * 1024
/** After a stop, how long to wait for the pipes to close before giving up on them. */
const CLOSE_GRACE_MS = 5_000
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export interface CheckRun {
  /** Null when the command never started or was ended by a signal. */
  exitCode: number | null
  /** Everything it printed, in the order it printed it, cut to its end and cleaned. */
  output: string
  timedOut: boolean
  cancelled: boolean
  startError?: string
  durationMs: number
}

export interface CheckOptions {
  cwd: string
  /** The shell the person chose for commands. */
  shell?: ShellPreference
  timeoutMs?: number
  signal?: AbortSignal
  /** Replaces the real shell start. For tests. */
  spawn?: typeof spawnShell
}

/** What a command printed as text for a person or a model: no color codes, no carriage returns, no secrets. */
export function cleanCheckOutput(text: string): string {
  return redactString(text.replace(ANSI, '').replace(/\r\n?/g, '\n')).trimEnd()
}

/**
 * Run a goal's check command the way `run_command` runs one: in the task's folder, in the shell the person chose, with
 * Cubex's own credentials kept out of its environment, and with its whole process tree stopped when time runs out or the
 * goal is paused. The command is the person's own, typed with the goal.
 */
export function runCheckCommand(command: string, options: CheckOptions): Promise<CheckRun> {
  const started = Date.now()
  const finish = (partial: Omit<CheckRun, 'durationMs'>): CheckRun => ({ ...partial, durationMs: Date.now() - started })
  if (options.signal?.aborted) return Promise.resolve(finish({ exitCode: null, output: '', timedOut: false, cancelled: true }))

  return new Promise<CheckRun>((settle) => {
    let child: ReturnType<typeof spawnShell>
    try {
      child = (options.spawn ?? spawnShell)(resolveShell(options.shell ?? 'auto'), command, { cwd: options.cwd, env: childEnvironment() })
    } catch (error) {
      settle(finish({ exitCode: null, output: '', timedOut: false, cancelled: false, startError: error instanceof Error ? error.message : String(error) }))
      return
    }

    let output = ''
    let timedOut = false
    let cancelled = false
    let done = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const keep = (chunk: Buffer | string): void => { output = (output + chunk.toString()).slice(-CHECK_OUTPUT_CAP) }
    const end = (exitCode: number | null, startError?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener('abort', onAbort)
      settle(finish({ exitCode, output: cleanCheckOutput(output), timedOut, cancelled, ...(startError ? { startError } : {}) }))
    }
    const stop = (): void => {
      void terminateShellTree(child)
      // A process whose pipes stay open after it is gone must not keep the goal waiting.
      grace = setTimeout(() => end(null), CLOSE_GRACE_MS)
    }
    const onAbort = (): void => { cancelled = true; stop() }
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs ?? CHECK_TIMEOUT_MS)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    // Reads can fail while the tree is being stopped; `close` reports how it ended.
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)
    child.once('error', (error) => end(null, error.message))
    child.once('close', (code) => end(timedOut || cancelled ? null : code))
  })
}
