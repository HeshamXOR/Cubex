import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { peerCommandLine, type CliPeer } from '@shared/peers'
import { childEnvironment } from '../childEnv'
import { LaunchError, locateCommand, resolveLaunch, type LaunchInput, type LaunchPlan } from '../mcp/resolveLaunch'
import { terminateShellTree } from '../tools/shellProcess'
import { cleanOutput, failureHint, parsePeerOutput, PEER_STDERR_TAIL, PEER_STDOUT_CAP, tail } from './output'

/** How long a program may take to answer one message. Agents that read a project and think can take minutes. */
export const PEER_TIMEOUT_MS = 10 * 60_000
/** What one command line can carry on Windows is 32,767 characters, which is the tightest limit among the systems. */
export const ARGUMENT_PROMPT_LIMIT = 28_000
export const STDIN_PROMPT_LIMIT = 120_000
/** After a stop, how long to wait for the program's pipes to close before giving up on them. */
const CLOSE_GRACE_MS = 5_000

export interface PeerRunOptions {
  /** The whole text for the program: the protocol, what was said before, and the new message. */
  prompt: string
  /** Where the program starts: an empty scratch folder, or the project when it may read it. */
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Where PATH and the variables to pass are read from. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv
  /** Replaces the lookup that decides how to start the program. For tests. */
  launch?: (input: LaunchInput) => LaunchPlan
}

export interface PeerRun {
  ok: boolean
  /** What the agent said. Empty on a failure. */
  reply: string
  /** One sentence on what went wrong. */
  error?: string
  /** What to do about it. */
  hint?: string
  /** What the program wrote to its error output, cleaned and cut to its end. */
  output?: string
  durationMs: number
}

// --- Where a program is found ------------------------------------------------

/** Where installers put command line tools that a desktop app launched from a menu often does not have on its PATH. */
function fallbackDirectories(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    ...(process.platform === 'win32' ? [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')] : ['/usr/local/bin', '/opt/homebrew/bin'])
  ]
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** What a program is started with: the environment Cubex hands to any child, plus the variables the person chose to pass, and the usual tool folders at the end of PATH. */
export function peerEnvironment(peer: CliPeer, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnvironment(base)
  for (const name of peer.passEnv ?? []) {
    // Names are not case sensitive on Windows, and are everywhere else.
    const key = process.platform === 'win32' ? Object.keys(base).find((candidate) => candidate.toLowerCase() === name.toLowerCase()) : name
    const value = key === undefined ? undefined : base[key]
    if (key !== undefined && value !== undefined) env[key] = value
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const entries = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
  for (const directory of fallbackDirectories()) if (!entries.some((entry) => samePath(entry, directory))) entries.push(directory)
  env[pathKey] = entries.join(delimiter)
  return env
}

/** The file a program peer would run, or undefined when it is not installed. */
export function locatePeer(peer: CliPeer, base: NodeJS.ProcessEnv = process.env): string | undefined {
  return locateCommand({ command: peer.command, env: peerEnvironment(peer, base) })
}

// --- The empty folder a program starts in -------------------------------------

const SCRATCH_MAX_AGE_MS = 24 * 3_600_000
let swept = false

function scratchRoot(): string {
  return join(tmpdir(), 'cubex-consult')
}

/** Folders a crash or a stuck handle left behind are removed once a day's age is passed. */
function sweepScratch(root: string): void {
  if (swept) return
  swept = true
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name)
      try { if (Date.now() - statSync(path).mtimeMs > SCRATCH_MAX_AGE_MS) rmSync(path, { recursive: true, force: true }) } catch { /* in use: next time */ }
    }
  } catch { /* nothing to sweep */ }
}

/** A new empty folder to run a program in when it may not see the project: it can only read what the message carries. */
export function createScratch(): string {
  const root = scratchRoot()
  mkdirSync(root, { recursive: true })
  sweepScratch(root)
  return mkdtempSync(join(root, 'c-'))
}

export function removeScratch(directory: string): void {
  // Only ever something this module made.
  if (!resolve(directory).startsWith(scratchRoot() + sep)) return
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept later */ }
}

// --- Running it ---------------------------------------------------------------

/** The launch error, in words about a message rather than about a server. */
function launchProblem(error: LaunchError): { error: string; hint?: string } {
  if (/cmd\.exe would reinterpret/.test(error.message)) {
    return {
      error: 'This program starts through a Windows batch file, which cannot take a message that contains quotes, percent signs or line breaks.',
      hint: 'Use a version of the program that installs an .exe, or add it as another program that reads the message on standard input.'
    }
  }
  return { error: error.message }
}

/**
 * Ask a program one question and return its answer. The program is started without a shell, in the folder it was given,
 * with Cubex's own credentials kept out of its environment. It is stopped, with everything it started, when the time is
 * up or the turn is cancelled. Nothing it prints is trusted: output is bounded, cleaned and read as data.
 */
export async function runCliPeer(peer: CliPeer, options: PeerRunOptions): Promise<PeerRun> {
  const started = Date.now()
  const failed = (error: string, extra: Partial<PeerRun> = {}): PeerRun => ({ ok: false, reply: '', error, durationMs: Date.now() - started, ...extra })
  if (options.signal?.aborted) return failed('Cancelled.')

  const line = peerCommandLine(peer)
  const limit = line.input === 'argument' ? ARGUMENT_PROMPT_LIMIT : STDIN_PROMPT_LIMIT
  if (options.prompt.length > limit) {
    return failed(`The message is ${options.prompt.length.toLocaleString('en-US')} characters, which is more than ${peer.name} can be sent at once (${limit.toLocaleString('en-US')}).`, { hint: 'Send a shorter message.' })
  }

  const env = peerEnvironment(peer, options.env)
  let plan: LaunchPlan
  try {
    plan = (options.launch ?? resolveLaunch)({
      command: line.command,
      args: line.input === 'argument' ? [...line.args, options.prompt] : line.args,
      cwd: options.cwd,
      env
    })
  } catch (error) {
    if (error instanceof LaunchError) {
      const problem = launchProblem(error)
      return failed(problem.error, problem.hint ? { hint: problem.hint } : {})
    }
    return failed(error instanceof Error ? error.message : String(error))
  }

  return await new Promise<PeerRun>((settle) => {
    let child: ChildProcess
    try {
      child = spawn(plan.file, plan.args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        // On POSIX the program leads its own group, so stopping it stops what it started too.
        detached: process.platform !== 'win32',
        stdio: [line.input === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      settle(failed(`${peer.name} could not be started: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    const stdout: string[] = []
    let stdoutSize = 0
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let done = false
    let grace: ReturnType<typeof setTimeout> | undefined

    const finish = (run: PeerRun): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener('abort', onAbort)
      settle(run)
    }
    const stop = (): void => {
      void terminateShellTree(child)
      // A program whose pipes stay open after it is gone must not keep the turn waiting.
      grace = setTimeout(() => finish(failed(cancelled ? 'Cancelled.' : timedOut ? `${peer.name} did not answer in time and was stopped.` : `${peer.name} was stopped.`)), CLOSE_GRACE_MS)
    }
    const onAbort = (): void => { cancelled = true; stop() }
    const timeoutMs = options.timeoutMs ?? PEER_TIMEOUT_MS
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdoutSize >= PEER_STDOUT_CAP) return
      const piece = chunk.slice(0, PEER_STDOUT_CAP - stdoutSize)
      stdout.push(piece)
      stdoutSize += piece.length
    })
    child.stderr?.setEncoding('utf8')
    // Twice what is reported, so the end of a long stream survives the cut.
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-PEER_STDERR_TAIL * 2) })
    // Reads and writes can fail when the tree is stopped; the close event reports how it ended.
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)
    child.stdin?.on('error', () => undefined)

    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(failed(`${peer.name} could not be started: ${error.message}`, code === 'ENOENT' || code === 'EACCES'
        ? { hint: 'Check that the program is installed and that its name or path is right.' } : {}))
    })

    child.once('close', (code) => {
      const seconds = Math.round((Date.now() - started) / 1000)
      if (cancelled) return finish(failed('Cancelled.'))
      const errors = cleanOutput(stderr)
      const output = errors ? tail(errors, PEER_STDERR_TAIL) : undefined
      const withOutput = output ? { output } : {}
      if (timedOut) {
        return finish(failed(`${peer.name} did not answer within ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes and was stopped.`, { hint: 'Ask a smaller question, or try again.', ...withOutput }))
      }
      const parsed = parsePeerOutput(line.format, stdout.join(''))
      if (code !== 0 || parsed.error) {
        const reason = parsed.error ? tail(parsed.error, 500) : `${peer.name} stopped with exit code ${code ?? 'unknown'} after ${seconds} seconds.`
        const hint = failureHint(`${parsed.error ?? ''}\n${errors}`, code)
        return finish(failed(reason, { ...(hint ? { hint } : {}), ...withOutput }))
      }
      if (!parsed.reply) {
        return finish(failed(`${peer.name} finished without a reply.`, {
          hint: peer.preset === 'antigravity'
            ? 'Run "agy update". Versions before 1.1.1 print nothing when started without a terminal on Windows.'
            : 'Check that the program prints its answer to standard output, and that it was given the message the way it reads it.',
          ...withOutput
        }))
      }
      finish({ ok: true, reply: parsed.reply, durationMs: Date.now() - started, ...withOutput })
    })

    if (line.input === 'stdin') child.stdin?.end(options.prompt)
  })
}
