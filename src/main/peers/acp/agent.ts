import type { AcpPeer } from '@shared/peers'
import type { LaunchInput, LaunchPlan } from '../../mcp/resolveLaunch'
import { cleanOutput, failureHint, PEER_STDERR_TAIL, tail } from '../output'
import { PEER_TIMEOUT_MS } from '../peerRunner'
import { AcpClosedError, AcpConnection, AcpRequestError, RPC_ERROR } from './connection'
import { AcpFailure } from './failure'
import { chooseMode, classifyMode, isCareful, modeNames, suitsPurpose, taskReadiness, type AcpMode, type TaskReadiness } from './modes'
import { canonicalPath, consultPolicy, type AcpPolicy } from './permissions'
import type { AcpProcess } from './process'
import { startFor, type AcpStart } from './starters'

export { AcpFailure }

/**
 * One consulted agent: a program started with the Agent Client Protocol on its standard input and output, and the one
 * session Cubex opened in it. It starts the program, shakes hands, signs in when the agent asks, moves the agent into
 * its most careful mode, and then answers one message at a time. The agent is given no way to reach this computer
 * through Cubex: no file access and no terminal are offered, and its permission questions are answered by
 * `permissions.ts`.
 */

/** Cubex speaks version 1 of the protocol, the stable one. */
export const ACP_PROTOCOL_VERSION = 1
/** Starting an agent that npx has to download first can take a while. */
export const START_TIMEOUT_MS = 120_000
/** After a cancel, how long the agent has to wrap up before it is stopped. */
export const CANCEL_GRACE_MS = 5_000
/** After the end of its input, how long a program has to exit before it is stopped. */
const CLOSE_GRACE_MS = 1_000
/** The most of one reply that is kept. */
export const REPLY_COLLECT_CAP = 400_000

let reportedVersion = '0.0.0'

/** What agents are told this client's version is. The main process sets it to the running app's version at start. */
export function setAcpClientVersion(version: string): void {
  reportedVersion = version
}

export interface AcpReply {
  /** What the agent said, without its thoughts and tool calls. */
  text: string
  /** How the agent says its turn ended: end_turn, max_tokens, max_turn_requests or refusal. */
  stopReason: string
  /** The reply was longer than what is kept. */
  capped: boolean
}

/** What an agent reports while it works, for a card that shows the work as it goes. */
export type AcpEvent = { type: 'step'; id: string; title: string; kind: string; state: 'running' | 'done' | 'failed' }

export interface PromptOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Told about each tool call the agent makes and how it ends. */
  onEvent?: (event: AcpEvent) => void
}

/** What a pool of sessions needs from an agent. Lets the pool be tested without starting a program. */
export interface AcpAgentLike {
  readonly alive: boolean
  prompt(text: string, options?: PromptOptions): Promise<AcpReply>
  /** Whether the agent could take a task that changes the project, from the modes it offered when the session opened. */
  taskReadiness?(): TaskReadiness
  /** End the session politely, then stop the program if it is still there. */
  close(): Promise<void>
  /** Stop the program and what it started now. `sync` waits for that to be done, for when the app is quitting. */
  kill(sync?: boolean): void
}

export interface OpenOptions {
  peer: AcpPeer
  /** The folder the agent starts in: the project, or an empty folder. It is the only place the agent may read. */
  cwd: string
  /** Where PATH and the variables to pass are read from. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv
  /** What the agent may do and how its permission questions are answered. Defaults to a consultation: look and answer. */
  policy?: AcpPolicy
  signal?: AbortSignal
  startTimeoutMs?: number
  /** After a cancel, how long the agent has to wrap up before it is stopped. */
  cancelGraceMs?: number
  /** Replaces the lookup that decides how to start the program. For tests. */
  launch?: (input: LaunchInput) => LaunchPlan
  /** Replaces how the agent's process is started, which otherwise depends on its preset. For tests. */
  start?: AcpStart
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What to try, when an agent sent that along with an error: Cubex's own bridges do. It is cleaned and kept short like anything else an agent says. */
function hintFrom(data: unknown): string | undefined {
  const hint = isRecord(data) && typeof data.hint === 'string' ? tail(cleanOutput(data.hint), 400) : ''
  return hint || undefined
}

/** A time in the unit a person thinks of it in: seconds below a minute, minutes above. */
function duration(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000))
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  }
  const minutes = Math.round(ms / 60_000)
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

// --- What the agent says about itself ---------------------------------------------

interface AuthMethod {
  id: string
  name: string
  /** Only the kind that the agent runs itself can be used here. */
  runsInAgent: boolean
}

function authMethods(value: unknown): AuthMethod[] {
  if (!Array.isArray(value)) return []
  const out: AuthMethod[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.methodId === 'string' ? entry.methodId : undefined
    if (!id) continue
    out.push({ id, name: typeof entry.name === 'string' && entry.name ? entry.name : id, runsInAgent: entry.type === undefined || entry.type === 'agent' })
  }
  return out
}

interface ModeState {
  current: string | undefined
  available: AcpMode[]
  /** How a mode is chosen: session/set_mode, or session/set_config_option for an agent that offers modes as an option. */
  via: { type: 'modes' } | { type: 'config'; id: string }
}

function modeOf(entry: unknown): AcpMode | undefined {
  if (!isRecord(entry)) return undefined
  const id = typeof entry.id === 'string' ? entry.id : typeof entry.value === 'string' ? entry.value : undefined
  return id ? { id, name: typeof entry.name === 'string' && entry.name ? entry.name : id } : undefined
}

/** The options of a select, flat or in groups. */
function choicesOf(options: unknown): AcpMode[] {
  if (!Array.isArray(options)) return []
  const out: AcpMode[] = []
  for (const entry of options) {
    if (isRecord(entry) && Array.isArray(entry.options)) out.push(...choicesOf(entry.options))
    else {
      const mode = modeOf(entry)
      if (mode) out.push(mode)
    }
  }
  return out
}

function readModes(created: Record<string, unknown>): ModeState | undefined {
  const modes = created.modes
  if (isRecord(modes) && Array.isArray(modes.availableModes)) {
    const available = modes.availableModes.map(modeOf).filter((mode): mode is AcpMode => mode !== undefined)
    return { current: typeof modes.currentModeId === 'string' ? modes.currentModeId : undefined, available, via: { type: 'modes' } }
  }
  if (Array.isArray(created.configOptions)) {
    for (const option of created.configOptions) {
      if (!isRecord(option) || option.category !== 'mode' || option.type !== 'select' || typeof option.id !== 'string') continue
      return { current: typeof option.currentValue === 'string' ? option.currentValue : undefined, available: choicesOf(option.options), via: { type: 'config', id: option.id } }
    }
  }
  return undefined
}

// --- The agent ---------------------------------------------------------------------

interface Active {
  text: string
  capped: boolean
  /** A tool call came after the last words: the next words start a new paragraph. */
  afterTool: boolean
  cancelling: boolean
  onEvent: ((event: AcpEvent) => void) | undefined
  /** The tool calls seen so far, so an update that carries only a status can be named. */
  tools: Map<string, { title: string; kind: string; state: 'running' | 'done' | 'failed' }>
}

/** Tool calls remembered by name: an agent that makes a great many does not grow this without end. */
const MAX_TOOLS_REMEMBERED = 500

export class AcpAgent implements AcpAgentLike {
  private readonly connection: AcpConnection
  private readonly root: string
  private sessionId = ''
  private stderr = ''
  private exited = false
  private killed = false
  private active: Active | undefined
  /** The agent moved itself into a mode that does not ask; the reason it was stopped. */
  private unsafeMode: string | undefined
  private readonly ended: Promise<void>
  private mode: ModeState | undefined
  private readonly policy: AcpPolicy

  private constructor(private readonly peer: AcpPeer, private readonly child: AcpProcess, private readonly cwd: string, private readonly cancelGraceMs: number, policy?: AcpPolicy) {
    if (!child.stdin || !child.stdout) throw new AcpFailure(`${peer.name} could not be started: its input and output were not opened.`)
    this.root = canonicalPath(cwd) ?? cwd
    this.policy = policy ?? consultPolicy(this.root)
    this.connection = new AcpConnection(child.stdout, child.stdin, {
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.agentRequest(method, params)
    })
    child.stderr?.setEncoding('utf8')
    // Twice what is reported, so the end of a long stream survives the cut.
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-PEER_STDERR_TAIL * 2) })
    child.stderr?.on('error', () => undefined)
    this.ended = new Promise<void>((done) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.exited = true
        this.connection.close(new AcpClosedError(error.message, undefined, error.code))
        done()
      })
      child.once('close', (code) => {
        this.exited = true
        this.connection.close(new AcpClosedError('The program ended.', code))
        done()
      })
    })
  }

  /** Start the program and get it to a session that is ready for a message. */
  static async open(options: OpenOptions): Promise<AcpAgent> {
    const { peer } = options
    if (options.signal?.aborted) throw new AcpFailure('Cancelled.')
    const child = await (options.start ?? startFor(peer))({ peer, cwd: options.cwd, env: options.env, policy: options.policy, signal: options.signal, launch: options.launch })
    const agent = new AcpAgent(peer, child, options.cwd, options.cancelGraceMs ?? CANCEL_GRACE_MS, options.policy)
    try {
      await agent.handshake(options)
      return agent
    } catch (error) {
      agent.kill()
      throw error
    }
  }

  get alive(): boolean {
    return !this.exited && !this.killed && !this.connection.closed
  }

  /** Whether this agent could take a task that changes the project: whether it offered a mode in which it asks first. */
  taskReadiness(): TaskReadiness {
    return taskReadiness(this.mode?.available ?? [])
  }

  // -- Starting ------------------------------------------------------------------------

  private async handshake(options: OpenOptions): Promise<void> {
    const limit = options.startTimeoutMs ?? START_TIMEOUT_MS
    let timedOut = false
    const onAbort = (): void => this.kill()
    const timer = setTimeout(() => { timedOut = true; this.kill() }, limit)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const init = await this.connection.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Nothing of this computer is offered: the agent reads and runs with its own tools, under the policy.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cubex', title: 'Cubex', version: reportedVersion }
      })
      const version = isRecord(init) ? init.protocolVersion : undefined
      if (version !== ACP_PROTOCOL_VERSION) {
        throw new AcpFailure(`${this.peer.name} speaks version ${typeof version === 'number' ? version : 'unknown'} of the Agent Client Protocol, and Cubex speaks version ${ACP_PROTOCOL_VERSION}.`, {
          hint: 'Update the program, or the Cubex release that matches it.'
        })
      }
      const created = await this.openSession(isRecord(init) ? authMethods(init.authMethods) : [])
      await this.secureMode(created)
    } catch (error) {
      if (options.signal?.aborted) throw new AcpFailure('Cancelled.')
      throw this.failure(error, timedOut ? { startTimeoutMs: limit } : {})
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** session/new, signing in first when the agent says it has to be done. */
  private async openSession(methods: AuthMethod[]): Promise<Record<string, unknown>> {
    const create = (): Promise<unknown> => this.connection.request('session/new', { cwd: this.cwd, mcpServers: [] })
    let created: unknown
    try {
      created = await create()
    } catch (error) {
      if (!(error instanceof AcpRequestError) || error.code !== RPC_ERROR.authRequired) throw error
      await this.signIn(methods)
      created = await create()
    }
    if (!isRecord(created) || typeof created.sessionId !== 'string' || !created.sessionId) {
      throw new AcpFailure(`${this.peer.name} did not open a session.`, { hint: 'Check that the program speaks the Agent Client Protocol, and that its arguments make it do so.' })
    }
    this.sessionId = created.sessionId
    return created
  }

  private async signIn(methods: AuthMethod[]): Promise<void> {
    const name = this.peer.name
    const usable = methods.filter((method) => method.runsInAgent)
    const wanted = this.peer.authMethod
    let id: string
    if (wanted) id = wanted
    else if (usable.length === 1) id = usable[0]!.id
    else if (usable.length === 0) {
      throw new AcpFailure(`${name} asks to be signed in, and offers no way that Cubex can use.`, {
        hint: 'Start the program once in a terminal and sign in there. Cubex uses what it saves.'
      })
    } else {
      const list = usable.map((method) => `${method.id} (${method.name})`).join(', ')
      throw new AcpFailure(`${name} asks to be signed in and offers more than one way: ${list}.`, { hint: 'Choose one under Edit, in "Sign-in method".' })
    }
    try {
      await this.connection.request('authenticate', { methodId: id })
    } catch (error) {
      if (!(error instanceof AcpRequestError)) throw error
      throw new AcpFailure(`${name} could not sign in with "${id}": ${tail(cleanOutput(error.message), 300)}`, {
        hint: 'Start the program once in a terminal and sign in there, or give it the key it needs under "Variables to pass".'
      })
    }
  }

  /** Move the agent into the mode that fits the job, or refuse an agent that has none and is not in one. */
  private async secureMode(created: Record<string, unknown>): Promise<void> {
    const state = readModes(created)
    this.mode = state
    if (!state) return
    const purpose = this.policy.purpose
    const choice = chooseMode(state.current, state.available, purpose)
    if (choice.action === 'keep') return
    const name = this.peer.name
    if (choice.action === 'refuse' && choice.why === 'nothing-asks') {
      throw new AcpFailure(`${name} has no mode in which it asks before it changes things (it offers: ${modeNames(choice.offered)}), so Cubex cannot hold it to your permission mode.`, {
        hint: 'Hand it tasks that only read, such as research or review, or use an agent that asks first, such as Claude Code, Codex or Gemini.'
      })
    }
    if (choice.action === 'refuse') {
      const kind = classifyMode(choice.current)
      throw new AcpFailure(
        kind === 'unsafe'
          ? `${name} is in the mode "${choice.current.name}", which makes changes without asking, and it has no mode that asks first.`
          : `${name} is in the mode "${choice.current.name}", and Cubex cannot tell that it asks before it makes changes.`,
        { hint: 'Cubex only talks to an agent that asks before it acts. Set a mode that does in the program, or use another agent.' }
      )
    }
    try {
      if (state.via.type === 'modes') await this.connection.request('session/set_mode', { sessionId: this.sessionId, modeId: choice.mode.id })
      else await this.connection.request('session/set_config_option', { sessionId: this.sessionId, configId: state.via.id, value: choice.mode.id })
    } catch (error) {
      if (!(error instanceof AcpRequestError)) throw error
      const current = state.available.find((mode) => mode.id === state.current)
      if (!current || !suitsPurpose(classifyMode(current), purpose)) {
        throw new AcpFailure(`${name} would not switch to its "${choice.mode.name}" mode, and the mode it is in is not one that asks first.`, {
          hint: 'Cubex only talks to an agent that asks before it acts. Set such a mode in the program, or use another agent.'
        })
      }
    }
  }

  // -- Asking --------------------------------------------------------------------------

  async prompt(text: string, options: PromptOptions = {}): Promise<AcpReply> {
    const name = this.peer.name
    if (options.signal?.aborted) throw new AcpFailure('Cancelled.')
    if (!this.alive) throw new AcpFailure(`${name} is no longer running.`)
    if (this.active) throw new AcpFailure(`${name} is still answering another message.`)
    const active: Active = { text: '', capped: false, afterTool: false, cancelling: false, onEvent: options.onEvent, tools: new Map() }
    this.active = active
    const timeoutMs = options.timeoutMs ?? PEER_TIMEOUT_MS
    let why: 'cancelled' | 'timeout' | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const stop = (reason: 'cancelled' | 'timeout'): void => {
      if (active.cancelling) return
      active.cancelling = true
      why = reason
      // Per the protocol: ask the agent to stop, and if it does not wrap up, stop it.
      this.connection.notify('session/cancel', { sessionId: this.sessionId })
      grace = setTimeout(() => this.kill(), this.cancelGraceMs)
    }
    const onAbort = (): void => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
      if (why === 'cancelled') throw new AcpFailure('Cancelled.')
      if (why === 'timeout') throw this.failure(new Error('Timed out.'), { promptTimeoutMs: timeoutMs })
      if (this.unsafeMode) throw this.unsafeFailure(this.unsafeMode)
      const stopReason = isRecord(response) && typeof response.stopReason === 'string' ? response.stopReason : 'end_turn'
      if (stopReason === 'cancelled') throw new AcpFailure(`${name} stopped before it finished.`)
      return { text: active.text, stopReason, capped: active.capped }
    } catch (error) {
      if (this.unsafeMode) throw this.unsafeFailure(this.unsafeMode)
      if (why === 'cancelled') throw new AcpFailure('Cancelled.')
      throw this.failure(error, why === 'timeout' ? { promptTimeoutMs: timeoutMs } : {})
    } finally {
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener('abort', onAbort)
      this.active = undefined
    }
  }

  // -- What the agent sends --------------------------------------------------------------

  private notification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params) || params.sessionId !== this.sessionId || !isRecord(params.update)) return
    const update = params.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.collect(update.content)
        break
      case 'tool_call':
        if (this.active) this.active.afterTool = true
        this.toolEvent(update)
        break
      case 'tool_call_update':
        this.toolEvent(update)
        break
      case 'current_mode_update':
        this.modeChanged(update.currentModeId)
        break
    }
  }

  /** A tool call, or an update to one, as a step: its title, its kind and whether it is running, done or failed. */
  private toolEvent(update: Record<string, unknown>): void {
    const active = this.active
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
    if (!active?.onEvent || !id) return
    const known = active.tools.get(id)
    const title = (typeof update.title === 'string' ? update.title : known?.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
    if (!title) return
    const kind = typeof update.kind === 'string' && update.kind ? update.kind.slice(0, 20) : known?.kind ?? 'other'
    const state = update.status === 'completed' ? 'done' : update.status === 'failed' ? 'failed' : update.status === 'pending' || update.status === 'in_progress' ? 'running' : known?.state ?? 'running'
    if (known && known.title === title && known.kind === kind && known.state === state) return
    if (!known && active.tools.size >= MAX_TOOLS_REMEMBERED) active.tools.delete(active.tools.keys().next().value as string)
    active.tools.set(id, { title, kind, state })
    try { active.onEvent({ type: 'step', id, title, kind, state }) } catch { /* a card that fails to draw must not stop the agent */ }
  }

  private collect(content: unknown): void {
    const active = this.active
    if (!active || active.capped || !isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') return
    let piece = content.text
    if (active.afterTool && active.text && !active.text.endsWith('\n')) piece = `\n\n${piece}`
    active.afterTool = false
    const room = REPLY_COLLECT_CAP - active.text.length
    if (piece.length > room) {
      piece = piece.slice(0, Math.max(0, room))
      active.capped = true
    }
    active.text += piece
  }

  /** An agent that moves itself into a mode that does not ask has stopped being held to the policy. */
  private modeChanged(modeId: unknown): void {
    if (typeof modeId !== 'string' || !this.mode) return
    const mode = this.mode.available.find((entry) => entry.id === modeId) ?? { id: modeId, name: modeId }
    this.mode.current = modeId
    if (isCareful(classifyMode(mode))) return
    this.unsafeMode = mode.name
    this.kill()
  }

  private agentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      // Per the protocol, what is waiting when a turn is cancelled is answered as cancelled.
      if (this.active?.cancelling) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      return this.permission(params)
    }
    return Promise.reject(new AcpRequestError(RPC_ERROR.methodNotFound, `Method not found: ${method}`))
  }

  /** The policy's answer, which may wait for the person. A policy that fails is a refusal. */
  private async permission(params: unknown): Promise<unknown> {
    try {
      const reply = await this.policy.decide(params)
      return this.active?.cancelling ? { outcome: { outcome: 'cancelled' } } : reply
    } catch {
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  // -- Failing ---------------------------------------------------------------------------

  private unsafeFailure(mode: string): AcpFailure {
    return new AcpFailure(`${this.peer.name} moved itself into the mode "${mode}", which makes changes without asking, and was stopped.`, {
      hint: 'Cubex only talks to an agent that asks before it acts.'
    })
  }

  private failure(error: unknown, when: { startTimeoutMs?: number; promptTimeoutMs?: number } = {}): AcpFailure {
    if (error instanceof AcpFailure) return error
    const name = this.peer.name
    const errors = cleanOutput(this.stderr)
    const output = errors ? { output: tail(errors, PEER_STDERR_TAIL) } : {}
    if (when.startTimeoutMs !== undefined) {
      return new AcpFailure(`${name} did not get ready within ${duration(when.startTimeoutMs)} and was stopped.`, {
        hint: 'If it was downloading, try again. Otherwise check that its arguments make it speak the Agent Client Protocol.', ...output
      })
    }
    if (when.promptTimeoutMs !== undefined) {
      return new AcpFailure(`${name} did not answer within ${duration(when.promptTimeoutMs)} and was stopped.`, { hint: 'Ask a smaller question, or try again.', ...output })
    }
    if (error instanceof AcpRequestError) {
      const hint = hintFrom(error.data) ?? failureHint(`${error.message}\n${errors}`, undefined)
      return new AcpFailure(tail(cleanOutput(error.message), 500) || `${name} reported an error.`, { ...(hint ? { hint } : {}), ...output })
    }
    if (error instanceof AcpClosedError) {
      if (error.errno !== undefined) {
        return new AcpFailure(`${name} could not be started: ${error.message}`, {
          ...(error.errno === 'ENOENT' || error.errno === 'EACCES' ? { hint: 'Check that the program is installed and that its name or path is right.' } : {}),
          ...output
        })
      }
      const hint = failureHint(errors, error.exitCode)
      const code = error.exitCode === undefined || error.exitCode === null ? '' : ` with exit code ${error.exitCode}`
      return new AcpFailure(`${name} stopped unexpectedly${code}.`, { ...(hint ? { hint } : {}), ...output })
    }
    return new AcpFailure(error instanceof Error ? error.message : String(error), output)
  }

  // -- Ending ----------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.exited) return
    // The protocol's way to end: close the program's input, then stop it if it stays.
    try { this.child.stdin?.end() } catch { /* already closed */ }
    await Promise.race([this.ended, new Promise<void>((done) => setTimeout(done, CLOSE_GRACE_MS).unref())])
    if (!this.exited) this.kill()
  }

  kill(sync = false): void {
    if (this.killed) return
    this.killed = true
    try { this.child.stdin?.end() } catch { /* already closed */ }
    this.child.stop(sync)
  }
}
