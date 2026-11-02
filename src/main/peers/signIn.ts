import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 as winPath } from 'node:path'
import type { AgentSignInResult } from '@shared/agentCatalog'

/**
 * "Sign in" for an agent opens a terminal window that runs the agent's own sign-in command, the one its vendor documents
 * (`claude auth login`, `codex login`). The window is the program's: it opens the browser, asks what it asks and keeps what
 * it saves where it keeps it. Cubex does not see the window's input or output and never reads the login afterwards, it only
 * asks the program who it is signed in as. Only a command from the catalog is ever run here, with the program Cubex found.
 */

export interface SignInPlan {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

/** What cmd.exe would reinterpret inside the command line, or cannot be quoted at all. */
const UNQUOTABLE = /["%^!\u0000-\u001f]/

/**
 * The command that opens the window, for Windows: cmd.exe starts a new console that runs the program and stays open once
 * it ends, so the person can read how it went. The program and its arguments are quoted; a path that cmd.exe would
 * reinterpret is refused rather than guessed at.
 */
export function signInPlan(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SignInPlan | { error: string } {
  const parts = [program, ...args]
  if (parts.some((part) => UNQUOTABLE.test(part))) {
    return { error: 'The path of the program has a quote, a percent sign or another character the terminal cannot take safely.' }
  }
  const comspec = env.ComSpec ?? env.COMSPEC ?? winPath.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const inner = `""${program}" ${args.join(' ')}"`.replace(/ +"$/, '"')
  // /s makes cmd.exe remove the outer pair of quotes and run the rest as written. The title is the first quoted word of start.
  const line = `"start "Cubex sign-in" cmd.exe /d /v:off /k ${inner}"`
  return { file: comspec, args: ['/d', '/v:off', '/s', '/c', line], windowsVerbatimArguments: true }
}

export interface OpenOptions {
  program: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  /** The command as a person would type it, for the message when no window can be opened. */
  typed: string
  platform?: NodeJS.Platform
  /** Replaces the start of a process. For tests. */
  start?: typeof spawn
}

export function openSignIn(options: OpenOptions): AgentSignInResult {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return { ok: false, message: `Cubex opens a sign-in window on Windows only. Run "${options.typed}" in a terminal, then check again.` }
  }
  const plan = signInPlan(options.program, options.args, options.env)
  if ('error' in plan) return { ok: false, message: `${plan.error} Run "${options.typed}" in a terminal instead, then check again.` }
  try {
    const child = (options.start ?? spawn)(plan.file, plan.args, {
      cwd: homedir(),
      env: options.env,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    })
    child.on('error', () => undefined)
    child.unref()
    return { ok: true, message: 'A terminal window opened. Finish signing in there, then come back to this window. Cubex checks again when you do.' }
  } catch (error) {
    return { ok: false, message: `The sign-in window could not be opened: ${error instanceof Error ? error.message : String(error)} Run "${options.typed}" in a terminal instead.` }
  }
}
