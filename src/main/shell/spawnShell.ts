import { spawn, type ChildProcess } from 'node:child_process'
import type { ShellSpec } from './shellProvider'

export interface SpawnShellOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** `pipe` keeps stdin open so task_input can write to it; the default closes it (NUL), like a script with no tty. */
  stdin?: 'ignore' | 'pipe'
  /** Receives the script the shell will run, decoded (PowerShell's encoded form is opaque in a process list). */
  log?: (message: string) => void
}

/**
 * Start `command` in `spec`'s shell. Never shell:true and never a nested quoting layer: the
 * command is one argument (or one encoded blob) to the shell executable itself.
 * Throws ShellCommandTooLongError when the command cannot fit on a Windows command line.
 */
export function spawnShell(spec: ShellSpec, command: string, options: SpawnShellOptions): ChildProcess {
  const argv = spec.argv(command)
  try { options.log?.(`Starting ${spec.label} (${spec.exe}): ${spec.script(command)}`) } catch { /* Logging must not stop a command. */ }
  return spawn(spec.exe, argv, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    // POSIX shells get their own process group so the whole tree can be signalled.
    detached: process.platform !== 'win32',
    ...(spec.verbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
}
