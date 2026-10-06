import type { ChildProcess } from 'node:child_process'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import { terminateShellTree } from './shellProcess'
import { childEnvironment } from '../childEnv'
import type { CommandOutputArtifact, CommandOutputCompletion, CommandOutputStore, CommandOutputWriter } from '../commandOutput'
import { MAX_YIELD_MS, MIN_YIELD_MS, type ProcessManager } from '../processManager'
import { SHELL_IDS, resolveShell, type ShellPreference } from '../shell/shellProvider'
import { spawnShell } from '../shell/spawnShell'

const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 300_000
const MAX_OUTPUT = 30_000

export { isReadOnlyShellCommand } from './shellReadOnly'
export { childEnvironment } from '../childEnv'

function clip(s: string, originalLength = s.length): string {
  if (originalLength <= MAX_OUTPUT) return s
  const head = s.slice(0, MAX_OUTPUT * 0.7)
  const tail = s.slice(-MAX_OUTPUT * 0.3)
  return `${head}\n… [${originalLength - head.length - tail.length} chars truncated] …\n${tail}`
}

function failureGuidance(output: string, error?: NodeJS.ErrnoException): string {
  if (error?.code !== 'EACCES' && error?.code !== 'EPERM' && !/\b(?:access (?:is )?denied|permission denied|UnauthorizedAccessException)\b/i.test(output)) return ''
  return '\n\nThe command reported an operating-system access denial. Cubex approval does not override file or process permissions. ' +
    'Do not repeat the same command unchanged. For workspace inspection, use read_file or search_files; ' +
    'otherwise check the reported path and executable permissions before retrying.'
}

/**
 * Shell command execution, scoped to the workspace cwd. This runs ARBITRARY
 * commands, so it is `ask` by default and blocked in plan mode; the harness
 * auto-runs it only when the command is clearly read-only or the user is in a
 * bypass posture (see ChatService gating).
 */
export interface ShellToolOptions {
  outputStore?: Pick<CommandOutputStore, 'create'>
  conversationId?: string
  /** The chat turn this tool serves. A background task remembers it, so Stop on this turn can end it. */
  turnId?: string
  onOutputSaved?: (artifact: CommandOutputArtifact) => void
  processManager?: ProcessManager
  preferredShell?: ShellPreference
}

export function createShellTool(workspaceRoot: string, options: ShellToolOptions = {}): ExecutableTool {
  return {
    definition: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace directory (build, test, git, lint, scripts). Returns the exit ' +
        'code and combined stdout/stderr. Use RELATIVE paths. A foreground command must finish within its ' +
        'timeout; for a server, watcher or other long-running process set background: true, which returns a ' +
        'task ID you can follow with task_output, task_list, task_input and task_stop. Saved output IDs can be ' +
        'read with read_command_output when available. Prefer the file tools for reading/writing files.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command line to execute.' },
          timeout_ms: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).` },
          background: { type: 'boolean', description: 'Run command in the background without blocking the conversation turn.' },
          yield_ms: { type: 'number', description: 'For background tasks, max ms to wait for initial output or ready hint before yielding (default 10000, 250 to 30000).' },
          shell: { type: 'string', enum: [...SHELL_IDS], description: 'Override the preferred shell interpreter for this command.' }
        },
        required: ['command']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { toolUseId: '', content: 'run_command requires an object with a "command" string.', isError: true }
      }
      const { command, timeout_ms, background, yield_ms, shell } = input as {
        command?: string
        timeout_ms?: number
        background?: boolean
        yield_ms?: number
        shell?: string
      }
      if (typeof command !== 'string' || !command.trim() || command.includes('\0')) {
        return { toolUseId: '', content: 'run_command requires a non-empty "command" string without null bytes.', isError: true }
      }
      if (timeout_ms !== undefined && (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms <= 0)) {
        return { toolUseId: '', content: 'run_command "timeout_ms" must be a finite number greater than zero.', isError: true }
      }
      if (yield_ms !== undefined && (typeof yield_ms !== 'number' || !Number.isFinite(yield_ms))) {
        return {
          toolUseId: '',
          content: `run_command "yield_ms" must be a finite number between ${MIN_YIELD_MS} and ${MAX_YIELD_MS}.`,
          isError: true
        }
      }
      if (ctx?.signal?.aborted) return { toolUseId: '', content: 'run_command cancelled.', isError: true }

      // Foreground and background commands run in the same shell: the one this call names, else the user's
      // choice in Settings (read when the turn started), else the first installed one.
      const spec = resolveShell(SHELL_IDS.find((id) => id === shell) ?? options.preferredShell ?? 'auto')
      // A shell that is not installed falls back; the model must hear it, or it writes the wrong syntax again.
      const fallbackNote = spec.fallbackFrom ? `\n\nNote: ${spec.fallbackFrom} is not installed, so this ran in ${spec.label}.` : ''

      if (background === true) {
        if (!options.processManager) {
          return { toolUseId: '', content: 'Background task execution is not supported in this environment.', isError: true }
        }
        try {
          const runResult = await options.processManager.start({
            conversationId: options.conversationId ?? ctx.conversationId ?? '',
            ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
            command,
            cwd: workspaceRoot,
            spec,
            background: true,
            yieldMs: typeof yield_ms === 'number' ? Math.max(MIN_YIELD_MS, Math.min(yield_ms, MAX_YIELD_MS)) : undefined,
            timeoutMs: typeof timeout_ms === 'number' ? timeout_ms : undefined
          })
          if (runResult.exited) {
            const { status, exitCode } = runResult.task
            // A stopped task's exit code is whatever the kill produced, so it says nothing about the command.
            const exitNote = status === 'killed' ? 'The task was stopped before it finished.'
              : status === 'timed_out' ? 'The task reached its time limit and was stopped.'
              : exitCode !== undefined ? `Exit code: ${exitCode}` : 'Command exited.'
            const isError = status === 'failed' || status === 'timed_out'
            return {
              toolUseId: '',
              content: `${exitNote}\n\n${runResult.initialOutput || '(no output)'}${fallbackNote}`,
              isError,
              metadata: { taskId: runResult.task.id, commandOutputId: runResult.task.outputId }
            }
          }
          const readyNote = runResult.task.readyHint ? `\nReady: ${runResult.task.readyHint.line}` : ''
          const outputNote = runResult.initialOutput ? `\nInitial output:\n${runResult.initialOutput}` : '\n(Process running with no initial output)'
          return {
            toolUseId: '',
            content: `Background task started with ID: ${runResult.task.id} (${spec.label})${readyNote}${outputNote}\n\nUse task_output to monitor progress, task_input to write to stdin, or task_stop to kill.${fallbackNote}`,
            isError: false,
            metadata: { taskId: runResult.task.id, commandOutputId: runResult.task.outputId }
          }
        } catch (err) {
          return {
            toolUseId: '',
            content: `Failed to start background task: ${err instanceof Error ? err.message : String(err)}`,
            isError: true
          }
        }
      }

      const timeout = Math.min(Math.max(1000, Math.round(timeout_ms ?? DEFAULT_TIMEOUT)), MAX_TIMEOUT)
      let outputWriter: CommandOutputWriter | undefined
      let outputWarning: string | undefined
      const notifyOutput = (artifact: CommandOutputArtifact): void => {
        try { options.onOutputSaved?.(artifact) } catch { /* UI notification must not fail a command. */ }
      }
      if (options.outputStore) {
        try {
          outputWriter = options.outputStore.create(options.conversationId ?? ctx.conversationId ?? '', { command })
          notifyOutput(outputWriter.artifact)
        } catch (error) { outputWarning = `Command output could not be saved: ${error instanceof Error ? error.message : String(error)}` }
      }
      const resultWithOutput = (content: string, isError: boolean, completion: CommandOutputCompletion, failureCategory?: 'permission_denied'): ToolResult => {
        content += fallbackNote
        if (outputWriter) {
          try {
            const artifact = outputWriter.finish(completion)
            notifyOutput(artifact)
            const size = artifact.totalBytes === undefined ? `${artifact.capturedBytes} bytes captured` : `${artifact.capturedBytes} of ${artifact.totalBytes} bytes captured`
            content += `\n\nSaved output: ${artifact.id} (${size}${artifact.truncated ? '; capture truncated' : ''}). Use read_command_output with output_id=${artifact.id} to read or continue.`
            if (artifact.error) outputWarning = artifact.error
          } catch (error) {
            outputWarning = `Output ${outputWriter.id} was captured but its receipt could not be finalized: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (outputWarning) content += `\n\n${outputWarning}`
        return { toolUseId: '', content, isError, ...(outputWriter || failureCategory ? {
          metadata: { ...(outputWriter ? { commandOutputId: outputWriter.id } : {}), ...(failureCategory ? { failureCategory } : {}) }
        } : {}) }
      }

      return await new Promise<ToolResult>((resolve) => {
        let child: ChildProcess
        try {
          child = spawnShell(spec, command, { cwd: workspaceRoot, env: childEnvironment() })
        } catch (error) {
          const guidance = failureGuidance((error as Error).message, error as NodeJS.ErrnoException)
          const errorText = `Failed to start command: ${(error as Error).message}${guidance}`
          resolve(resultWithOutput(errorText, true, { status: 'failed', error: errorText }, guidance ? 'permission_denied' : undefined))
          return
        }
        let out = ''
        let outputCharacters = 0
        let settled = false
        let closed = false
        let spawned = false
        let stopReason: 'timeout' | 'cancelled' | undefined
        let termination: Promise<string | undefined> | undefined
        let closeTimer: ReturnType<typeof setTimeout> | undefined
        const onData = (data: string): void => {
          try { outputWriter?.append(data) } catch (error) { outputWarning ??= `Output capture failed: ${error instanceof Error ? error.message : String(error)}` }
          outputCharacters += data.length
          out += data
          // Keep raw head/tail text in memory. Insert one accurate clipping
          // marker at completion, rather than accumulating obsolete markers.
          if (out.length > MAX_OUTPUT * 2) out = out.slice(0, MAX_OUTPUT * 0.7) + out.slice(-MAX_OUTPUT * 0.3)
        }
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)

        const finish = (content: string, isError: boolean, details: Pick<CommandOutputCompletion, 'exitCode' | 'signal' | 'error'> = {}, failureCategory?: 'permission_denied'): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          clearTimeout(closeTimer)
          ctx?.signal?.removeEventListener('abort', onAbort)
          child.stdout?.removeListener('data', onData)
          child.stderr?.removeListener('data', onData)
          resolve(resultWithOutput(content, isError, {
            status: stopReason === 'timeout' ? 'timed_out' : stopReason === 'cancelled' ? 'cancelled' : isError ? 'failed' : 'completed',
            ...details
          }, failureCategory))
        }
        const finishStopped = (warning?: string): void => {
          const body = clip(out, outputCharacters).trim() || '(no output)'
          const status = stopReason === 'timeout'
            ? `Command timed out after ${timeout}ms${warning ? '.' : ' and was killed.'}`
            : 'Command was cancelled.'
          finish(`${status}${warning ? `\nTermination warning: ${warning}` : ''}\n\n${body}`, true, warning ? { error: warning } : {})
        }
        const terminate = (): void => {
          if (termination || !child.pid) return
          termination = terminateShellTree(child)
          void termination.then((warning) => {
            if (settled || closed) return
            // A descendant that deliberately detached can keep pipes open. Do not
            // leave cancellation waiting indefinitely for inherited file handles.
            closeTimer = setTimeout(() => {
              child.stdout?.destroy()
              child.stderr?.destroy()
              finishStopped(warning ?? 'Output streams stayed open after stopping the process tree.')
            }, 1_000)
          })
        }
        const stop = (reason: 'timeout' | 'cancelled'): void => {
          if (settled || closed || stopReason) return
          stopReason = reason
          clearTimeout(timer)
          terminate()
        }
        const timer = setTimeout(() => stop('timeout'), timeout)
        const onAbort = (): void => stop('cancelled')
        ctx?.signal?.addEventListener('abort', onAbort, { once: true })
        // Cover an abort that happened between the first check and registration.
        if (ctx?.signal?.aborted) onAbort()

        child.once('spawn', () => {
          spawned = true
          if (stopReason) terminate()
        })
        child.once('error', (error) => {
          const guidance = failureGuidance(error.message, error)
          const errorText = `${spawned ? 'Command failed' : 'Failed to start command'}: ${error.message}${guidance}`
          finish(errorText, true, { error: errorText }, guidance ? 'permission_denied' : undefined)
        })
        child.once('close', (code, signal) => {
          closed = true
          clearTimeout(timer)
          // The shell exited, but `cmd &` / nohup descendants may still run in its
          // process group. A tool call owns everything it started: reap them.
          if (process.platform !== 'win32' && child.pid && !stopReason) {
            try { process.kill(-child.pid, 'SIGKILL') } catch { /* ESRCH: group already empty */ }
          }
          if (settled) return
          if (stopReason) {
            void (termination ?? Promise.resolve(undefined)).then(finishStopped)
            return
          }
          const body = clip(out, outputCharacters).trim() || '(no output)'
          const status = signal ? `Command terminated by signal: ${signal}`
            : code === null ? 'Command exited without an exit code.' : `Exit code: ${code}`
          const isError = code !== 0 || signal !== null
          const guidance = isError ? failureGuidance(out) : ''
          finish(`${status}\n\n${body}${guidance}`, isError, { ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) }, guidance ? 'permission_denied' : undefined)
        })
      })
    }
  }
}
