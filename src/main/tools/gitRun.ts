import { spawn, type ChildProcess } from 'node:child_process'
import { childEnvironment } from '../childEnv'
import { terminateShellTree } from './shellProcess'

/** One git call. Reads finish in milliseconds; the limit only stops a hung process. */
export const GIT_TIMEOUT_MS = 15_000
/**
 * A call that writes and may run hooks (commit, switch). Stopping git mid-write is the one
 * thing that can leave an index.lock behind, so this is far longer than GIT_TIMEOUT_MS.
 */
export const GIT_WRITE_TIMEOUT_MS = 120_000
/** What a tool shows the model from one call: near 60 KB. */
export const MAX_OUTPUT_BYTES = 60 * 1024
/** Output kept from one call before a read is stopped (a commit is never stopped for being chatty). */
const MAX_CAPTURE_BYTES = 1024 * 1024
/** How long to wait for output pipes to close after git was stopped, e.g. a hook still holding them. */
const STOP_GRACE_MS = 1_500
const TERM_TO_KILL_MS = 2_000

/** Global flags for every read: no pager, no colour, readable non-ASCII names. */
export const READ_FLAGS = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false']

/**
 * Variables that would point git at a different repository, index or object store
 * than the workspace, or change how paths are read (a literal-pathspec setting
 * would defeat the :(literal) paths that writes use, and the other pathspec modes
 * make git refuse to run with the literal one reads set).
 */
const REPOSITORY_OVERRIDES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_EXTERNAL_DIFF',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'
])

/**
 * The hardened environment for every git call: no Cubex secrets, the SAFE_GIT_ENV
 * overrides (no fsmonitor, no pager, no prompts) and no inherited repository
 * overrides. Reads additionally get literal pathspecs, so a path from the model can
 * never be a glob or `:(magic)`, and skip the optional index lock. Writes do not:
 * hooks inherit this environment, and a hook that globs (`git diff --cached -- '*.go'`)
 * would silently match nothing. Writers mark each path `:(literal)` instead.
 */
export function gitEnvironment(readOnly = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Windows environment names are case-insensitive, so compare upper-cased.
  for (const [key, value] of Object.entries(childEnvironment())) if (!REPOSITORY_OVERRIDES.has(key.toUpperCase())) env[key] = value
  if (readOnly) {
    env.GIT_LITERAL_PATHSPECS = '1'
    env.GIT_OPTIONAL_LOCKS = '0'
  }
  return env
}

export interface GitRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Text for git's standard input (a commit message). Standard input is always closed after it. */
  input?: string
  /** A read: skips the optional index lock and is stopped once it has produced more output than is kept. */
  readOnly?: boolean
}

export interface GitRun {
  /** Git exited 0, or a read was stopped on purpose after producing more output than is kept. */
  ok: boolean
  /** Exit status; null when git did not start or was stopped. */
  code: number | null
  stdout: string
  stderr: string
  /** More output was produced than was kept. */
  truncated: boolean
  timedOut?: boolean
  aborted?: boolean
  /** Why git could not run at all (not installed, not executable). */
  startError?: string
  /** The git process id, so a caller that had to stop it can tidy up after it. */
  pid?: number
}

interface Capture {
  push(chunk: Buffer): void
  text(): string
  /** True once more bytes arrived than were kept. */
  overflowed(): boolean
}

function capture(limit: number): Capture {
  const chunks: Buffer[] = []
  let kept = 0
  let total = 0
  return {
    push(chunk) {
      total += chunk.length
      if (kept >= limit) return
      const part = chunk.subarray(0, limit - kept)
      chunks.push(part)
      kept += part.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    overflowed: () => total > kept
  }
}

/** Stop git and anything it started (hooks). POSIX gets SIGTERM first so git can remove its lock files. */
async function stopGit(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    await terminateShellTree(child)
    return
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal) } catch {
      try { child.kill(signal) } catch { /* Already gone. */ }
    }
  }
  signalGroup('SIGTERM')
  await new Promise<void>((resolve) => setTimeout(resolve, TERM_TO_KILL_MS))
  if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL')
}

function startFailure(error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') return 'git was not found. Install Git and make sure it is on PATH.'
  return `Could not start git: ${error.message}`
}

/**
 * Run git directly (spawn, shell: false, argument array: nothing is ever parsed by
 * a shell) in `cwd` with the hardened environment. Never rejects.
 *
 * spawn rather than execFile because execFile kills the child when its output
 * exceeds maxBuffer. That is right for a long diff but wrong for a commit, whose
 * hooks may be chatty: killing git mid-commit leaves lock files behind. Here a
 * read is stopped at the cap and every other call keeps draining, keeping only
 * the first MAX_CAPTURE_BYTES.
 */
export function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitRun> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  return new Promise<GitRun>((settle) => {
    const empty: GitRun = { ok: false, code: null, stdout: '', stderr: '', truncated: false }
    if (options.signal?.aborted) return settle({ ...empty, aborted: true })

    const out = capture(MAX_CAPTURE_BYTES)
    const err = capture(MAX_CAPTURE_BYTES)
    let finished = false
    let stopReason: 'timeout' | 'aborted' | 'size' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcess

    const onAbort = (): void => stop('aborted')
    const snapshot = (code: number | null): GitRun => {
      // Exit 0 means git finished by itself, even if a stop was requested a moment earlier.
      const finished = code === 0
      return {
        ok: finished || stopReason === 'size',
        code,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.overflowed() || err.overflowed(),
        ...(child.pid ? { pid: child.pid } : {}),
        ...(!finished && stopReason === 'timeout' ? { timedOut: true } : {}),
        ...(!finished && stopReason === 'aborted' ? { aborted: true } : {})
      }
    }
    const finish = (run: GitRun): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      options.signal?.removeEventListener('abort', onAbort)
      settle(run)
    }
    function stop(reason: 'timeout' | 'aborted' | 'size'): void {
      if (finished || stopReason) return
      stopReason = reason
      clearTimeout(timer)
      void stopGit(child).then(() => {
        if (finished) return
        // A descendant (a hook) can keep the output pipes open after git itself is gone.
        graceTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(snapshot(null))
        }, STOP_GRACE_MS)
      })
    }

    try {
      child = spawn('git', args, {
        cwd,
        env: gitEnvironment(options.readOnly),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX, so stopping git also stops its hooks.
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      return settle({ ...empty, startError: startFailure(error as NodeJS.ErrnoException) })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk)
      if (options.readOnly && out.overflowed()) stop('size')
    })
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    // git may exit before reading its input; that is reported by its exit status.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input ?? '')
    child.once('error', (error) => finish({ ...empty, startError: startFailure(error) }))
    child.once('close', (code) => finish(snapshot(code)))

    timer = setTimeout(() => stop('timeout'), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    // Cover an abort that happened while git was starting.
    if (options.signal?.aborted) onAbort()
  })
}

/** A short, plain explanation of a failed call for the model or the user. */
export function describeGitFailure(run: GitRun, what: string, limit = 4_000): string {
  if (run.startError) return run.startError
  if (run.timedOut) return `git ${what} did not finish in time and was stopped.`
  if (run.aborted) return `git ${what} was cancelled.`
  // Hooks write to either stream depending on the git version.
  const detail = [run.stderr.trim(), run.stdout.trim()].filter(Boolean).join('\n')
  const shown = detail.length > limit ? `${detail.slice(0, limit)}\n… [${detail.length - limit} more characters]` : detail
  return `git ${what} failed${run.code === null ? '' : ` (exit ${run.code})`}: ${shown || 'no output'}`
}

/**
 * Text to show for git output: at most `limit` UTF-8 bytes, cut on a character
 * and preferably a line boundary, with a notice saying what was left out.
 * `moreExists` is true when the capture itself already dropped output.
 */
export function clipOutput(text: string, moreExists = false, limit = MAX_OUTPUT_BYTES): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= limit && !moreExists) return text
  let end = Math.min(buffer.length, limit)
  // Never cut through a multi-byte character.
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
  let shown = buffer.subarray(0, end).toString('utf8')
  const lastLine = shown.lastIndexOf('\n')
  if (lastLine > 0 && lastLine > shown.length - 2_000) shown = shown.slice(0, lastLine)
  const kb = (bytes: number): number => Math.max(1, Math.round(bytes / 1024))
  const total = moreExists ? `more than ${kb(buffer.length)} KB` : `${kb(buffer.length)} KB`
  return `${shown}\n… [output truncated: showing about ${kb(Buffer.byteLength(shown))} KB of ${total}. Narrow the request, for example with a path, or ask the user to run the command in a terminal.]`
}

const repoLocks = new Map<string, Promise<unknown>>()

/**
 * Run `task` after every earlier task for the same repository has finished. Two
 * writers (the user's commit button and the model's git_commit) must not race for
 * git's index.lock. A failing task never blocks the ones behind it.
 */
export function withRepoLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const run = (repoLocks.get(key) ?? Promise.resolve()).then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  repoLocks.set(key, tail)
  void tail.then(() => { if (repoLocks.get(key) === tail) repoLocks.delete(key) })
  return run
}
