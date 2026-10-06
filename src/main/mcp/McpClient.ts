import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { looksLikeSecretName } from '@shared/policy'
import { childEnvironment } from '../childEnv'
import { missingSecretsMessage } from './mcpDiagnose'
import { makeScrubber, mergeChildEnvironment, type Scrubber } from './mcpEnv'
import { resolveLaunch } from './resolveLaunch'
import { formatCallToolResult } from './resultFormat'

/**
 * A hardened Model Context Protocol (MCP) client over stdio.
 * Speaks JSON-RPC 2.0 as newline-delimited JSON with handshake negotiation,
 * request timeouts, cancellation notifications, ping/pong support,
 * cursor pagination, tool change notifications, backoff with jitter,
 * bounded stderr capture with secret redaction, and tree-kill process termination.
 */

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpServerSpec {
  id: string
  name: string
  command: string
  args?: string[]
  /** Variables added to the server's environment, on top of the inherited one (see childEnv.ts). */
  env?: Record<string, string>
  /** The values in `env` that are credentials. Everything the client reports is scrubbed of them. */
  secretValues?: string[]
  /** Secret variables with no value to use. The server is not started until they are entered again. */
  missingSecrets?: string[]
  cwd?: string
  startupTimeoutMs?: number
  shutdownGraceMs?: number
  maxResultChars?: number
}

export interface McpClientOptions {
  startupTimeoutMs?: number
  shutdownGraceMs?: number
  maxResultChars?: number
  now?: () => number
  random?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  cleanup?: () => void
}

/** The fields the client reads from a server line. The server is untrusted, so any of them may be missing or odd. */
interface RpcLine {
  id?: number | string
  method?: string
  result?: unknown
  error?: { message?: string }
}

const REQUEST_TIMEOUT = 20_000
const MAX_STDERR_TAIL = 8_192
/** Kept raw, wider than what is shown, so a value cut by the edge of the window is not what is left on screen. */
const MAX_STDERR_RAW = MAX_STDERR_TAIL * 3
const MAX_LOG_LINES = 250

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function exitDetail(code: number | null, signal: string | null): string {
  if (code !== null) return ` with code ${code}`
  return signal ? ` (${signal})` : ''
}

function treeKill(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: Interface | null = null
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private readonly toolsChangedListeners = new Set<() => void>()
  private stderrLineBuffer = ''
  private loggedLinesCount = 0
  /** What the server wrote to stderr, as it wrote it. Never leaves the class; `stderrTail` is the scrubbed view. */
  private stderrRaw = ''

  tools: McpToolDef[] = []
  connected = false
  protocolVersion?: string
  serverInfo?: { name: string; version?: string }
  failures = 0
  retryAt = 0
  /** Why the last attempt failed or the last connection dropped; cleared by a successful connect. */
  lastError?: string
  /** How the server process ended, when it did. */
  lastExit?: { code: number | null; signal: string | null }
  /** The connect in flight, so two callers share one process instead of starting two. */
  private connecting: Promise<void> | null = null
  private retired = false
  /** Hides the secrets this server was given, and anything shaped like a known key, in whatever it says. */
  private readonly scrub: Scrubber

  constructor(
    private readonly spec: McpServerSpec,
    private readonly options: McpClientOptions = {}
  ) {
    // A plain variable whose name says credential (API_KEY, DB_PASSWORD) is hidden too, even when it was not marked secret.
    const named = Object.entries(spec.env ?? {}).filter(([name]) => looksLikeSecretName(name)).map(([, value]) => value)
    this.scrub = makeScrubber([...(spec.secretValues ?? []), ...named])
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * The last stderr output, for diagnostics when a server fails. It is scrubbed on every read, from a window
   * wider than what is returned, so a secret that arrived in two pieces is hidden too, and one that has only
   * begun to arrive is held back until the rest is known.
   */
  get stderrTail(): string {
    return this.scrub.growing(this.stderrRaw).slice(-MAX_STDERR_TAIL)
  }

  private get startupTimeout(): number {
    return this.spec.startupTimeoutMs ?? this.options.startupTimeoutMs ?? 15_000
  }

  private get shutdownGrace(): number {
    return this.spec.shutdownGraceMs ?? this.options.shutdownGraceMs ?? 1_000
  }

  private get maxChars(): number | undefined {
    return this.spec.maxResultChars ?? this.options.maxResultChars
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private random(): number {
    return this.options.random ? this.options.random() : Math.random()
  }

  /** Spawn the server, run the MCP handshake, and cache its tool list. Callers that arrive while it is starting share that attempt. */
  async connect(): Promise<void> {
    if (this.connected) return
    if (this.retired) throw new Error(`MCP server "${this.spec.name}" was turned off`)
    if (this.connecting) return this.connecting

    const now = this.now()
    if (this.retryAt > now) {
      const waitMs = this.retryAt - now
      throw new Error(`MCP connection failed recently; retry in ${waitMs}ms`)
    }

    this.connecting = this.start().finally(() => { this.connecting = null })
    return this.connecting
  }

  private async start(): Promise<void> {
    // Nothing was tried, so there is no failure to count or back off from: the person has to act.
    if (this.spec.missingSecrets && this.spec.missingSecrets.length > 0) {
      this.lastError = missingSecretsMessage(this.spec.missingSecrets)
      throw new Error(this.lastError)
    }
    // A server that died since the last use left its handles behind; start from nothing.
    if (this.child) this.killInternal()

    try {
      const env = mergeChildEnvironment(childEnvironment(), this.spec.env ?? {})
      const plan = resolveLaunch({
        command: this.spec.command,
        args: this.spec.args,
        cwd: this.spec.cwd,
        env
      })

      const child = spawn(plan.file, plan.args, {
        cwd: this.spec.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams

      this.child = child
      this.stderrRaw = ''
      this.stderrLineBuffer = ''
      this.loggedLinesCount = 0
      this.lastExit = undefined

      // Every handler first checks that `child` is still the current server: a late event from
      // one that was already replaced must not tear down its successor.
      child.on('error', (e) => this.lose(child, `MCP server "${this.spec.name}" failed to start: ${e.message}`))
      // A write can lose the race with the child exiting. Without a listener the `error` event on
      // stdin is an uncaught exception in the main process.
      child.stdin.on('error', (e) => this.lose(child, this.stdinMessage(e)))
      // Reads can fail the same way when a tree is killed (ECONNRESET on Windows).
      child.stdout.on('error', () => { /* `close` reports the exit. */ })
      child.stderr.on('error', () => { /* Diagnostics only; nothing depends on it. */ })
      child.on('close', (code, signal) => {
        if (this.child !== child) return
        this.lastExit = { code, signal }
        this.lose(child, `MCP server "${this.spec.name}" exited${exitDetail(code, signal)}`, false)
      })

      this.rl = createInterface({ input: child.stdout })
      this.rl.on('line', (line) => this.onLine(line))
      this.rl.on('error', () => { /* The stream closing is handled by `close`. */ })

      child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))

      const initRes = (await this.request(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'Cubex', version: '0.1.0' }
        },
        { timeoutMs: this.startupTimeout }
      )) as { protocolVersion?: string; serverInfo?: { name: string; version?: string } } | undefined

      const version = initRes?.protocolVersion
      if (!version || typeof version !== 'string' || version < '2024-11-05' || version > '2025-11-25') {
        throw new Error(`Unsupported protocol version "${version}"`)
      }

      this.protocolVersion = version
      this.serverInfo = initRes?.serverInfo ?? { name: 'unknown' }

      this.notify('notifications/initialized')
      await this.refreshTools()

      this.connected = true
      this.failures = 0
      this.retryAt = 0
      this.lastError = undefined
    } catch (error) {
      this.failures++
      const baseDelay = 500 * Math.pow(2, this.failures - 1)
      const jitter = this.random()
      const delay = Math.min(30_000, Math.round(baseDelay * (1 + jitter)))
      this.retryAt = this.now() + delay
      // What a caller is handed is scrubbed like what is recorded: a server can put any text in a version or an error.
      const clean = this.scrub(error instanceof Error ? error.message : String(error))
      this.lastError = clean

      this.killInternal()
      throw error instanceof Error && error.message === clean ? error : new Error(clean)
    }
  }

  async refreshTools(): Promise<void> {
    const allTools: McpToolDef[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined = undefined

    while (true) {
      const params = cursor !== undefined ? { cursor } : {}
      const res = (await this.request('tools/list', params)) as { tools?: McpToolDef[]; nextCursor?: string } | undefined
      const nextCursor = res?.nextCursor
      if (cursor !== undefined && nextCursor === cursor) {
        break
      }
      if (res?.tools && Array.isArray(res.tools)) {
        allTools.push(...res.tools)
      }
      if (!nextCursor || seenCursors.has(nextCursor)) {
        break
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    this.tools = allTools
  }

  async listTools(cursor?: string): Promise<{ tools: McpToolDef[]; nextCursor?: string }> {
    if (!this.connected) await this.connect()
    const params = cursor !== undefined ? { cursor } : {}
    const res = (await this.request('tools/list', params)) as { tools?: McpToolDef[]; nextCursor?: string } | undefined
    return {
      tools: Array.isArray(res?.tools) ? res.tools : [],
      nextCursor: res?.nextCursor
    }
  }

  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener)
    return () => {
      this.toolsChangedListeners.delete(listener)
    }
  }

  private notifyToolsChanged(): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener()
      } catch {}
    }
  }

  /** Call one tool; returns its formatted text and status. Never throws. */
  async callTool(
    name: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ text: string; isError: boolean; truncated?: boolean }> {
    if (options?.signal?.aborted) {
      return { text: 'Tool call was cancelled before execution', isError: true, truncated: false }
    }

    try {
      if (!this.connected) {
        await this.connect()
      }
    } catch (e) {
      return { text: `Tool call failed: ${(e as Error).message}`, isError: true, truncated: false }
    }

    if (options?.signal?.aborted) {
      return { text: 'Tool call was cancelled before execution', isError: true, truncated: false }
    }

    try {
      const res = await this.request(
        'tools/call',
        { name, arguments: args ?? {} },
        { timeoutMs: options?.timeoutMs, signal: options?.signal }
      )
      const formatted = formatCallToolResult(res, { maxChars: this.maxChars })
      const text = formatted.text.trim() ? formatted.text : '(no content)'
      return {
        text: this.scrub(text),
        isError: formatted.isError,
        truncated: formatted.truncated
      }
    } catch (e) {
      const err = e as Error
      return { text: `Tool call failed: ${this.scrub(err.message)}`, isError: true, truncated: false }
    }
  }

  private onStderr(chunk: Buffer): void {
    const raw = chunk.toString()
    this.stderrRaw = (this.stderrRaw + raw).slice(-MAX_STDERR_RAW)

    if (this.options.log) {
      this.stderrLineBuffer += raw
      const lines = this.stderrLineBuffer.split('\n')
      this.stderrLineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length > 0) {
          if (this.loggedLinesCount < MAX_LOG_LINES) {
            this.loggedLinesCount++
            this.options.log('info', this.scrub(line))
          } else if (this.loggedLinesCount === MAX_LOG_LINES) {
            this.loggedLinesCount++
            this.options.log('warn', `[MCP server "${this.spec.name}" stderr logging suppressed after ${MAX_LOG_LINES} lines]`)
          }
        }
      }
    }
  }

  private killInternal(): void {
    const pid = this.child?.pid
    this.failAll(new Error('client closed'))
    if (this.rl) {
      try { this.rl.close() } catch {}
      this.rl = null
    }
    if (this.child) {
      try { this.child.stdin.destroy() } catch {}
      try { this.child.stdout.destroy() } catch {}
      try { this.child.stderr.destroy() } catch {}
      if (pid) treeKill(pid)
      this.child = null
    }
    this.connected = false
  }

  /**
   * The server is gone or unusable (it exited, would not start, or its input pipe broke): fail every
   * request waiting on it with the reason and forget the process, so the next use starts a fresh one.
   * `kill` is false when the process already exited and there is nothing left to stop.
   */
  private lose(child: ChildProcessWithoutNullStreams, message: string, kill = true): void {
    if (this.child !== child) return
    const clean = this.scrub(message)
    this.lastError = clean
    this.connected = false
    this.failAll(new Error(clean))
    if (kill) {
      this.killInternal()
      return
    }
    if (this.rl) {
      try { this.rl.close() } catch {}
      this.rl = null
    }
    this.child = null
  }

  private stdinMessage(error: Error): string {
    const code = (error as NodeJS.ErrnoException).code
    return `MCP server "${this.spec.name}" stopped reading its input${code ? ` (${code})` : ''}; it has probably exited`
  }

  /** Immediate tree kill without grace period. */
  kill(): void {
    this.killInternal()
  }

  /** Stop the server for good: a tool call that is still holding this client must not start it again. */
  retire(): void {
    this.retired = true
    this.killInternal()
  }

  /** Graceful shutdown: closes stdin, waits for grace period, then tree-kills if not exited. */
  async close(): Promise<void> {
    if (!this.child) {
      this.connected = false
      return
    }

    const child = this.child
    const pid = child.pid
    this.failAll(new Error('client closed'))
    if (this.rl) {
      try { this.rl.close() } catch {}
      this.rl = null
    }
    this.child = null
    this.connected = false

    try {
      child.stdin.end()
    } catch {}

    const graceMs = this.shutdownGrace
    const exited = await new Promise<boolean>((resolve) => {
      let resolved = false
      const onDone = () => {
        if (!resolved) {
          resolved = true
          resolve(true)
        }
      }
      child.once('exit', onDone)
      child.once('close', onDone)
      if (child.exitCode !== null || (pid && !isProcessAlive(pid))) {
        onDone()
      } else {
        setTimeout(() => {
          if (!resolved) {
            resolved = true
            resolve(false)
          }
        }, graceMs)
      }
    })

    if (!exited && pid && isProcessAlive(pid)) {
      treeKill(pid)
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return // ignore non-JSON log noise on stdout
    }
    // A line that parses but is not a message (`null`, a number) would throw on the property reads below.
    if (typeof parsed !== 'object' || parsed === null) return
    const msg = parsed as RpcLine

    // 1. Server-initiated notifications
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'notifications/tools/list_changed') {
        void this.refreshTools().then(() => {
          this.notifyToolsChanged()
        }, () => { /* The server went away before it could list; the next connect lists again. */ })
      }
      return
    }

    // 2. Server-initiated requests
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'ping') {
        this.send({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` }
        })
      }
      return
    }

    // 3. Response to our request
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      p.cleanup?.()
      if (msg.error) p.reject(new Error(this.scrub(typeof msg.error.message === 'string' ? msg.error.message : 'MCP error')))
      else p.resolve(msg.result)
    }
  }

  /** Write one line to the server. A broken pipe loses the connection (see `lose`) instead of throwing. */
  private write(payload: string): boolean {
    const child = this.child
    if (!child?.stdin?.writable) return false
    try {
      child.stdin.write(payload, (error) => { if (error) this.lose(child, this.stdinMessage(error)) })
    } catch (error) {
      this.lose(child, this.stdinMessage(error as Error))
      return false
    }
    return true
  }

  private send(obj: unknown): void {
    this.write(JSON.stringify(obj) + '\n')
  }

  private notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.send(payload)
  }

  private request(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<unknown> {
    const id = this.nextId++

    return new Promise<unknown>((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        const message = `MCP server "${this.spec.name}" is not running`
        // A connection whose input is gone cannot recover; drop it so the next use starts a new one.
        if (this.child) this.lose(this.child, message)
        return reject(new Error(message))
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          this.notify('notifications/cancelled', { requestId: id, reason: `MCP "${method}" timed out after ${timeoutMs}ms` })
          reject(new Error(`MCP "${method}" timed out`))
        }, timeoutMs)
      }

      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        this.notify('notifications/cancelled', { requestId: id, reason: 'Request was cancelled' })
        reject(new Error(`MCP "${method}" was cancelled`))
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
      }

      options?.signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, { resolve, reject, cleanup })

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      // A failed write has already rejected every pending request through `lose`; this covers a pipe that was not writable.
      if (!this.write(payload) && this.pending.delete(id)) {
        cleanup()
        reject(new Error(`MCP server "${this.spec.name}" is not running`))
      }
    })
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup?.()
      p.reject(err)
    }
    this.pending.clear()
  }
}
