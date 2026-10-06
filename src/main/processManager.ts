import { nanoid } from 'nanoid'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { BackgroundTask } from '@shared/ipc'
import { terminateShellTree, terminateShellTreeSync } from './tools/shellProcess'
import type { ShellSpec } from './shell/shellProvider'
import { spawnShell } from './shell/spawnShell'
import { childEnvironment } from './childEnv'
import type { CommandOutputStore, CommandOutputWriter } from './commandOutput'

export const MAX_LIVE_TASKS_PER_CONVERSATION = 8
export const MAX_LIVE_TASKS_PER_APP = 16

/** One write to a task's standard input. A line of input is far smaller; this only stops a runaway paste. */
export const MAX_TASK_INPUT_CHARS = 16 * 1024

/** Exited tasks per session that keep their output buffers, newest first. */
export const MAX_BUFFERED_EXITED_PER_CONVERSATION = 4
/** Exited task records kept per session; older ones are forgotten entirely. */
export const MAX_EXITED_RECORDS_PER_CONVERSATION = 16

const HEAD_RING_BYTES = 16 * 1024
const TAIL_RING_BYTES = 48 * 1024

export { HEAD_RING_BYTES, TAIL_RING_BYTES }

/** UTF-8 size of one code point. */
function utf8Size(code: number): number {
  if (code <= 0x7f) return 1
  if (code <= 0x7ff) return 2
  if (code <= 0xffff) return 3
  return 4
}

/**
 * Walks whole code points from the start of `text`. `atMost` stops before the
 * budget is exceeded, `atLeast` stops as soon as it is reached.
 */
function spanByBytes(text: string, budget: number, mode: 'atMost' | 'atLeast'): { units: number; bytes: number } {
  let bytes = 0
  let units = 0
  while (units < text.length) {
    const code = text.codePointAt(units)!
    const size = utf8Size(code)
    if (mode === 'atMost' && bytes + size > budget) break
    bytes += size
    units += code > 0xffff ? 2 : 1
    if (mode === 'atLeast' && bytes >= budget) break
  }
  return { units, bytes }
}

/**
 * Head and tail rings over a child's output, bounded by real UTF-8 bytes so
 * non-ASCII output cannot grow past the cap, and decoded with a carried-over
 * decoder so a sequence split across chunks is never mangled.
 */
export class OutputBuffer {
  private readonly decoder = new StringDecoder('utf8')
  private head = ''
  private headBytes = 0
  private tail = ''
  private tailBytes = 0
  private released = false
  private persisted = false
  /** Bytes the child wrote, including anything the rings dropped. */
  totalBytes = 0

  get headByteLength(): number {
    return this.headBytes
  }

  get tailByteLength(): number {
    return this.tailBytes
  }

  get isReleased(): boolean {
    return this.released
  }

  /** Decodes a chunk into the rings and returns its text for other consumers. */
  write(chunk: Buffer): string {
    const text = this.decoder.write(chunk)
    this.totalBytes += chunk.length
    if (this.released || !text) return text

    const room = HEAD_RING_BYTES - this.headBytes
    if (room > 0) {
      const span = spanByBytes(text, room, 'atMost')
      this.head += text.slice(0, span.units)
      this.headBytes += span.bytes
    }

    this.tail += text
    this.tailBytes += Buffer.byteLength(text, 'utf8')
    if (this.tailBytes > TAIL_RING_BYTES) {
      const cut = spanByBytes(this.tail, this.tailBytes - TAIL_RING_BYTES, 'atLeast')
      this.tail = this.tail.slice(cut.units)
      this.tailBytes -= cut.bytes
    }

    return text
  }

  /** Head and tail joined, with an explicit marker for anything dropped. */
  format(): string {
    if (this.released) return this.releasedNote()
    if (this.totalBytes <= TAIL_RING_BYTES) return this.tail

    // The rings overlap while they still cover the whole stream; drop the
    // duplicated prefix of the tail so the output reads continuously.
    const overlap = this.headBytes + this.tailBytes - this.totalBytes
    const cut = overlap > 0 ? spanByBytes(this.tail, overlap, 'atLeast') : { units: 0, bytes: 0 }
    const tail = this.tail.slice(cut.units)
    const dropped = this.totalBytes - this.headBytes - (this.tailBytes - cut.bytes)
    if (dropped <= 0) return this.head + tail
    return `${this.head}\n… [${dropped} bytes truncated] …\n${tail}`
  }

  /** The last `limit` bytes, with a marker whenever earlier output is dropped. */
  tailText(limit: number): string {
    if (this.released) return this.releasedNote()
    let text = this.tail
    let kept = this.tailBytes
    if (limit > 0 && kept > limit) {
      const cut = spanByBytes(text, kept - limit, 'atLeast')
      text = text.slice(cut.units)
      kept -= cut.bytes
    }
    const dropped = this.totalBytes - kept
    if (dropped <= 0) return text
    return `… [${dropped} bytes truncated] …\n${text}`
  }

  /** Free the rings once the task is old enough to stop holding memory. */
  release(persisted: boolean): void {
    this.released = true
    this.persisted = persisted
    this.head = ''
    this.tail = ''
    this.headBytes = 0
    this.tailBytes = 0
  }

  private releasedNote(): string {
    return this.persisted
      ? `… [buffered output released to free memory; all ${this.totalBytes} bytes are in this task's saved command output] …`
      : `… [buffered output released to free memory; ${this.totalBytes} bytes are no longer available] …`
  }
}

const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const MAX_WALL_CLOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours

const DEFAULT_YIELD_MS = 10_000
export const MIN_YIELD_MS = 250
export const MAX_YIELD_MS = 30_000

export interface StartProcessOptions {
  conversationId: string
  /** The chat turn that asked for this process, so Stop on that turn can end it and Stop on a later turn cannot. */
  turnId?: string
  command: string
  cwd: string
  spec: ShellSpec
  background?: boolean
  yieldMs?: number
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ProcessRunResult {
  task: BackgroundTask
  initialOutput: string
  exited: boolean
}

export interface ReadyHint {
  url?: string
  port?: number
  line: string
}

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * A loopback URL and nothing else. The host must end where the port, path or sentence does, so
 * "http://localhost.evil.example/" is not read as a local server the user could be sent to.
 */
const LOOPBACK_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(?=[/?#\s)'"\],;]|\.(?:\s|$)|$)(?:[/?#][^\s)'"]*)?/i

export function detectReadyHint(text: string): ReadyHint | undefined {
  const lines = text.replace(ANSI_SEQUENCE, '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 1. Matches URLs like "http://localhost:5173", "http://127.0.0.1:3000", etc.
    const urlMatch = LOOPBACK_URL.exec(trimmed)
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,;:!?]+$/, '')
      const port = urlMatch[1] ? parseInt(urlMatch[1], 10) : undefined
      return { url, port, line: trimmed }
    }

    // 2. Matches "listening on port 8080" or "server at port 3000"
    const portMatch = /(?:listening on|server at|running on|port)\s+(?:port\s+)?(\d{2,5})/i.exec(trimmed)
    if (portMatch && portMatch[1]) {
      const port = parseInt(portMatch[1], 10)
      return { port, line: trimmed }
    }

    // 3. Matches "ready in", "Compiled successfully", "ready on"
    if (/(?:ready in\s+\d+|compiled successfully|ready on)/i.test(trimmed)) {
      return { line: trimmed }
    }
  }
  return undefined
}

interface ProcessEntry {
  task: BackgroundTask
  /** The turn that started it; only that turn's Stop ends it (see cancelTurn). */
  turnId?: string
  /** Start order, so reaping keeps the newest tasks even within one millisecond. */
  sequence: number
  child: ChildProcess | null
  writer?: CommandOutputWriter
  buffer: OutputBuffer
  timer?: NodeJS.Timeout
  readyPromiseResolve?: (hint: ReadyHint) => void
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Told about every task change; `turnId` is the chat turn that started it, when it came from one. */
export type TaskListener = (task: BackgroundTask, turnId?: string) => void

export interface ProcessManagerOptions {
  /** Tests force a platform to exercise the Windows behavior everywhere. */
  platform?: NodeJS.Platform
}

export const WINDOWS_INTERRUPT_UNSUPPORTED =
  'Interrupt is not available for a background task on Windows: the task runs on a pipe with no console, so Ctrl+C cannot reach it. ' +
  'Nothing was sent. Use task_stop to end the process and its children.'

export class ProcessManager {
  private readonly tasks = new Map<string, ProcessEntry>()
  private readonly listeners = new Set<TaskListener>()
  private nextSequence = 1
  private readonly outputStore?: Pick<CommandOutputStore, 'create'>
  private readonly platform: NodeJS.Platform

  constructor(outputStore?: Pick<CommandOutputStore, 'create'>, options: ProcessManagerOptions = {}) {
    this.outputStore = outputStore
    this.platform = options.platform ?? process.platform
  }

  /**
   * Calls `listener` whenever a task starts, announces it is ready, ends or is stopped, for as long as
   * the manager lives. A turn's own callback goes quiet when the turn ends, but a dev server outlives it.
   */
  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Tasks that were forgotten (conversation deleted, app quitting) stay silent while their processes wind down. */
  private notify(entry: ProcessEntry): void {
    if (this.tasks.get(entry.task.id) !== entry) return
    const snapshot = { ...entry.task }
    for (const listener of this.listeners) {
      try { listener(snapshot, entry.turnId) } catch { /* an observer must never break a task */ }
    }
  }

  async start(options: StartProcessOptions): Promise<ProcessRunResult> {
    const { conversationId, command, cwd, spec, background } = options

    // 1. Check caps
    const totalLive = Array.from(this.tasks.values()).filter((e) => e.task.status === 'running').length
    if (totalLive >= MAX_LIVE_TASKS_PER_APP) {
      throw new Error(`Process limit reached: maximum ${MAX_LIVE_TASKS_PER_APP} concurrent tasks across the application.`)
    }

    const convLive = Array.from(this.tasks.values()).filter(
      (e) => e.task.conversationId === conversationId && e.task.status === 'running'
    ).length
    if (convLive >= MAX_LIVE_TASKS_PER_CONVERSATION) {
      throw new Error(`Process limit reached: maximum ${MAX_LIVE_TASKS_PER_CONVERSATION} concurrent tasks for this session.`)
    }

    const taskId = `p_${nanoid(6)}`
    let writer: CommandOutputWriter | undefined
    if (this.outputStore) {
      try {
        writer = this.outputStore.create(conversationId, { command })
      } catch {
        // Output storage failure must not block command launch.
      }
    }

    const outputId = writer ? writer.id : nanoid()
    const task: BackgroundTask = {
      id: taskId,
      conversationId,
      command,
      shell: spec.id,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      outputId
    }

    let child: ChildProcess
    try {
      child = spawnShell(spec, command, {
        cwd,
        env: childEnvironment(options.env ?? process.env),
        stdin: 'pipe'
      })
    } catch (error) {
      // A command the shell cannot take (too long for Windows, for one) must not leave its saved output "running".
      try { writer?.finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) }) } catch { /* the launch error is the one worth reporting */ }
      throw error
    }

    task.pid = child.pid

    let resolveExit!: (res: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve
    })

    const entry: ProcessEntry = {
      task,
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      sequence: this.nextSequence++,
      child,
      writer,
      buffer: new OutputBuffer(),
      exitPromise
    }

    this.tasks.set(taskId, entry)

    // Handle data streams
    const onData = (chunk: Buffer): void => {
      const text = entry.buffer.write(chunk)
      if (!text) return

      // Append to writer
      if (entry.writer) {
        try {
          entry.writer.append(text)
        } catch {}
      }

      // ReadyHint detection
      if (!task.readyHint) {
        const hint = detectReadyHint(text)
        if (hint) {
          task.readyHint = hint
          this.notify(entry)
          entry.readyPromiseResolve?.(hint)
        }
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    // Handle exit
    child.once('close', (code, signal) => {
      if (entry.timer) clearTimeout(entry.timer)

      if (task.status === 'running') {
        task.status = code === 0 ? 'exited' : 'failed'
      }
      task.exitCode = code ?? undefined
      task.endedAt = Date.now()

      if (entry.writer) {
        try {
          const finalStatus =
            task.status === 'timed_out'
              ? 'timed_out'
              : task.status === 'killed'
              ? 'cancelled'
              : task.status === 'exited'
              ? 'completed'
              : 'failed'
          entry.writer.finish({ status: finalStatus, exitCode: code ?? undefined, signal: signal ?? undefined })
        } catch {}
      }

      this.notify(entry)
      resolveExit({ code, signal })
      this.reap(conversationId)
    })

    child.once('error', (err) => {
      if (entry.timer) clearTimeout(entry.timer)
      if (task.status === 'running') {
        task.status = 'failed'
      }
      task.endedAt = Date.now()
      if (entry.writer) {
        try {
          entry.writer.finish({ status: 'failed', error: err.message })
        } catch {}
      }
      this.notify(entry)
      resolveExit({ code: 1, signal: null })
      this.reap(conversationId)
    })

    // Wall-clock timeout
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS, MAX_WALL_CLOCK_TIMEOUT_MS)
    entry.timer = setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timed_out'
        this.notify(entry)
        void terminateShellTree(child)
      }
    }, timeoutMs)

    this.notify(entry)

    // Initial yield handling
    if (!background) {
      // Foreground: wait until exit or timeout
      await exitPromise
      return {
        task,
        initialOutput: this.formatBufferedOutput(entry),
        exited: true
      }
    }

    // Background: wait for yieldMs or fast exit or readyHint
    const requested = options.yieldMs
    const yieldMs = Number.isFinite(requested)
      ? Math.max(MIN_YIELD_MS, Math.min(requested!, MAX_YIELD_MS))
      : DEFAULT_YIELD_MS

    let yieldTimer: NodeJS.Timeout
    const timerPromise = new Promise<'timeout'>((res) => {
      yieldTimer = setTimeout(() => res('timeout'), yieldMs)
    })

    const readyPromise = new Promise<'ready'>((res) => {
      entry.readyPromiseResolve = () => res('ready')
    })

    await Promise.race([exitPromise, timerPromise, readyPromise])
    clearTimeout(yieldTimer!)

    const exited = task.status !== 'running'
    return {
      task,
      initialOutput: this.formatBufferedOutput(entry),
      exited
    }
  }

  private formatBufferedOutput(entry: ProcessEntry): string {
    return entry.buffer.format()
  }

  /**
   * Keep a session's finished tasks bounded. Without this every task holds its
   * rings and its child handle for the life of the app. The newest few keep
   * their buffers so `task_output` still works for a task the model just ran.
   */
  private reap(conversationId: string): void {
    const exited = Array.from(this.tasks.entries())
      .filter(([, e]) => e.task.conversationId === conversationId && e.task.status !== 'running')
      .sort((a, b) => b[1].sequence - a[1].sequence)

    exited.forEach(([id, entry], index) => {
      if (index >= MAX_EXITED_RECORDS_PER_CONVERSATION) {
        this.tasks.delete(id)
        return
      }
      if (index < MAX_BUFFERED_EXITED_PER_CONVERSATION || entry.buffer.isReleased) return
      entry.buffer.release(entry.writer !== undefined)
      entry.child = null
    })
  }

  list(conversationId?: string): BackgroundTask[] {
    const all = Array.from(this.tasks.values()).map((e) => ({ ...e.task }))
    if (!conversationId) return all
    return all.filter((t) => t.conversationId === conversationId)
  }

  get(taskId: string): BackgroundTask | undefined {
    const entry = this.tasks.get(taskId)
    return entry ? { ...entry.task } : undefined
  }

  /**
   * Mark the task stopped and tell observers at once, then end its whole process tree. Both platforms
   * force-kill (SIGKILL to the process group, `taskkill /T /F`): the task gets no chance to clean up.
   */
  private async terminate(entry: ProcessEntry): Promise<string | undefined> {
    entry.task.status = 'killed'
    this.notify(entry)
    return entry.child ? await terminateShellTree(entry.child) : undefined
  }

  async stop(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.tasks.get(taskId)
    if (!entry) return { ok: false, error: `Task ${taskId} not found.` }
    if (entry.task.status !== 'running' || !entry.child) return { ok: true }

    const warning = await this.terminate(entry)
    return { ok: true, error: warning }
  }

  async sendInput(taskId: string, input?: string, interrupt = false): Promise<{ ok: boolean; error?: string }> {
    const entry = this.tasks.get(taskId)
    if (!entry) return { ok: false, error: `Task ${taskId} not found.` }
    if (entry.task.status !== 'running' || !entry.child) {
      return { ok: false, error: `Task ${taskId} is not running.` }
    }
    if (input !== undefined && input.length > MAX_TASK_INPUT_CHARS) {
      return { ok: false, error: `Input is longer than ${MAX_TASK_INPUT_CHARS} characters. Nothing was sent.` }
    }
    const child = entry.child

    if (interrupt) {
      if (this.platform === 'win32') {
        // A piped child has no console of its own, and only
        // GenerateConsoleCtrlEvent interrupts cmd or PowerShell. Writing 0x03
        // to the pipe would be read as ordinary input, so report the truth
        // instead of claiming an interrupt that never happened.
        return { ok: false, error: WINDOWS_INTERRUPT_UNSUPPORTED }
      }
      try {
        // The shell owns its process group on POSIX, so signal the whole tree.
        if (child.pid) process.kill(-child.pid, 'SIGINT')
        else child.kill('SIGINT')
      } catch (e) {
        try {
          child.kill('SIGINT')
        } catch {
          return { ok: false, error: `Could not interrupt task ${taskId}: ${(e as Error).message}` }
        }
      }
    }

    if (input !== undefined && input.length > 0) {
      const stdin = child.stdin
      if (!stdin?.writable) {
        return { ok: false, error: `Process ${taskId} standard input is not writable.` }
      }
      const data = input.endsWith('\n') ? input : `${input}\n`
      // The child can exit between the writable check and the write; without a
      // listener the resulting EPIPE would be an uncaught exception.
      const error = await new Promise<Error | undefined>((resolve) => {
        const onError = (err: Error): void => resolve(err)
        stdin.once('error', onError)
        stdin.write(data, (err) => {
          stdin.off('error', onError)
          resolve(err ?? undefined)
        })
      })
      if (error) {
        return { ok: false, error: `Could not write to task ${taskId} standard input: ${error.message}` }
      }
    }

    return { ok: true }
  }

  async getOutput(
    taskId: string,
    waitMs = 0,
    tailBytes = TAIL_RING_BYTES
  ): Promise<{ text: string; task: BackgroundTask }> {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new Error(`Task ${taskId} not found.`)

    if (waitMs > 0 && entry.task.status === 'running') {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          entry.exitPromise,
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.min(waitMs, 30_000))
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    return { text: entry.buffer.tailText(tailBytes), task: { ...entry.task } }
  }

  /**
   * Ends the running tasks one turn started and leaves every other task of the conversation alone: a dev
   * server from an earlier turn is not part of this turn's work. It keeps running until the user stops it,
   * the conversation is deleted or the app quits.
   */
  async cancelTurn(conversationId: string, turnId: string): Promise<void> {
    const started = Array.from(this.tasks.values()).filter(
      (e) => e.task.conversationId === conversationId && e.turnId === turnId && e.task.status === 'running'
    )
    await Promise.all(started.map((entry) => this.terminate(entry)))
  }

  async deleteConversation(conversationId: string): Promise<void> {
    // Entries leave the map first, so the renderer is not told about tasks of a conversation that is gone.
    const doomed = Array.from(this.tasks.values()).filter((e) => e.task.conversationId === conversationId)
    for (const entry of doomed) this.tasks.delete(entry.task.id)
    await Promise.all(doomed.filter((e) => e.task.status === 'running').map((entry) => this.terminate(entry)))
  }

  async dispose(): Promise<void> {
    // Entries leave the map before any kill is awaited, so overlapping dispose
    // calls (window-all-closed plus before-quit) never fire two kill rounds at
    // the same child.
    const entries = Array.from(this.tasks.values())
    this.tasks.clear()
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.timer) clearTimeout(entry.timer)
        if (entry.task.status !== 'running' || !entry.child) return
        entry.task.status = 'killed'
        await terminateShellTree(entry.child)
      })
    )
  }

  /**
   * Kill every live task without yielding. Electron exits as soon as the
   * `before-quit` handler returns, so an awaited kill would be abandoned and
   * the descendants would keep holding their ports.
   */
  disposeSync(): void {
    const entries = Array.from(this.tasks.values())
    this.tasks.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.task.status !== 'running' || !entry.child) continue
      entry.task.status = 'killed'
      terminateShellTreeSync(entry.child)
    }
  }
}
