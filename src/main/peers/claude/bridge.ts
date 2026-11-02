import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { AcpConnection, AcpRequestError, RPC_ERROR } from '../acp/connection'
import { finishOutput, latchedProcess, type AcpProcess, type ProcessOutcome } from '../acp/process'
import { cleanOutput, failureHint, PEER_STDERR_TAIL, tail } from '../output'
import { allowTool, controlRequest, denyTool, isRecord, isSignedOut, LineSplitter, looksSignedOut, parseMessage, readAccount, refuseRequest, stopReasonOf, userMessage, type ClaudeAccount } from './protocol'
import { describeTool, oneLine, type ToolInfo } from './tools'

/**
 * Claude Code as an agent that speaks the Agent Client Protocol, without the adapter from npm and without Node: Cubex starts
 * the program the Claude desktop app or the command line installed, in its own stream-json mode, and this translates between
 * the two. Everything above it (the session pool, the chat's permission mode, the cards that show the work) is the same as for
 * any other agent, because to them this is one.
 *
 * Claude Code asks before it uses a tool (`can_use_tool`); that becomes `session/request_permission`, and the answer, which
 * is the chat's permission mode applied by the policy, goes back as allow or deny. The only choices offered are "this once":
 * "always" would be written to the person's own Claude Code settings. And because that question is the only thing that holds
 * Claude Code to the policy, a tool that changes something and runs without it ends the turn and the program.
 */

/** The version of the protocol this speaks: the first, stable one. */
const ACP_VERSION = 1
const DEFAULT_START_TIMEOUT_MS = 90_000
/** After the end of its input, how long Claude Code has to exit before it is stopped. */
const CLOSE_GRACE_MS = 3_000
/** Tool calls remembered for the turn: a model that makes a great many does not grow this without end. */
const MAX_TOOLS_REMEMBERED = 500

const ALLOW_ONCE = 'allow_once'
const REJECT_ONCE = 'reject_once'

export const SIGN_IN_HINT = 'Sign in to Claude Code first. In Settings, use "Sign in" beside it under "Found on this PC", or run claude in a terminal and type /login. To use an API key instead, add ANTHROPIC_API_KEY under "Variables to pass".'

const DENIED = 'Cubex did not allow this. Carry on without it, or stop and say what you could not do.'

/** What changes something or reaches out. Claude Code is asked about every one of these, so one that ran without a question got past the policy. */
const ASKED_ABOUT = new Set(['edit', 'delete', 'move', 'execute', 'fetch'])

export interface BridgeOptions {
  /** Claude Code, started with `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`. */
  claude: AcpProcess
  /** The folder it was started in. */
  cwd: string
  /** What the person sees it called, in messages. */
  name?: string
  /** How long Claude Code has to answer its first message. */
  startTimeoutMs?: number
  /** After the end of its input, how long Claude Code has to exit before it is stopped. */
  closeGraceMs?: number
  /** Called once when the bridge is over, to remove what it made. */
  cleanup?: () => void
}

interface ToolState {
  info: ToolInfo
  /** The person's policy was asked about it. */
  asked: boolean
}

interface Turn {
  resolve: (reply: { stopReason: string }) => void
  reject: (error: Error) => void
  cancelled: boolean
  tools: Map<string, ToolState>
  /** Cubex ended the turn, not Claude Code: this is why. */
  stopped?: AcpRequestError
}

interface ControlWait {
  resolve: (response: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class ClaudeBridge {
  /** What the agent's side holds in place of a program. */
  readonly process: AcpProcess
  private readonly toClient = new PassThrough()
  private readonly fromClient = new PassThrough()
  private readonly errors = new PassThrough()
  private readonly connection: AcpConnection
  private readonly lines: LineSplitter
  private readonly settle: (outcome: ProcessOutcome) => void
  private readonly claude: AcpProcess
  private readonly cwd: string
  private readonly name: string
  private readonly initialized: Promise<{ account: ClaudeAccount | undefined }>
  private readonly controlWaits = new Map<string, ControlWait>()
  /** Questions Claude Code is waiting on, by its request id; one that is no longer here was answered or withdrawn. */
  private readonly questions = new Set<string>()
  private sessionId = ''
  private turn: Turn | undefined
  private nextRequest = 1
  private ended = false
  private stderrTail = ''
  /** Lines that were not messages Cubex knows. */
  ignored = 0

  constructor(private readonly options: BridgeOptions) {
    this.claude = options.claude
    this.cwd = options.cwd
    this.name = options.name ?? 'Claude Code'
    const made = latchedProcess({ stdin: this.fromClient, stdout: this.toClient, stderr: this.errors }, (sync) => this.stop(sync))
    this.process = made.process
    this.settle = made.settle
    this.connection = new AcpConnection(this.fromClient, this.toClient, {
      onRequest: (method, params) => this.clientRequest(method, params),
      onNotification: (method) => { if (method === 'session/cancel') this.cancel() }
    })
    // The client ending its input is how the protocol ends a session.
    this.fromClient.on('end', () => this.clientClosed())

    this.lines = new LineSplitter((line) => this.read(line))
    const { stdout, stderr, stdin } = options.claude
    stdout?.setEncoding('utf8')
    stdout?.on('data', (chunk: string) => this.lines.push(chunk))
    stdout?.on('end', () => this.lines.end())
    stdout?.on('error', () => undefined)
    stderr?.setEncoding('utf8')
    stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-PEER_STDERR_TAIL * 2)
      if (!this.ended) this.errors.write(chunk)
    })
    stderr?.on('error', () => undefined)
    stdin?.on('error', () => undefined)
    options.claude.once('error', (error) => this.end({ kind: 'error', error }))
    options.claude.once('close', (code) => this.end({ kind: 'close', code }))

    this.initialized = this.control({ subtype: 'initialize', hooks: null }, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      .then((response) => ({ account: readAccount(response.account) }))
    // Whoever needs it asks for it; if nobody does, a failure is not an unhandled one.
    this.initialized.catch(() => undefined)
  }

  // -- Talking to Claude Code --------------------------------------------------------------

  private send(message: Record<string, unknown>): void {
    if (this.ended) return
    try {
      this.claude.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The pipe is closed: the program's exit reports it.
    }
  }

  /** A control request: Claude Code answers it with a control response. */
  private control(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = `cubex_${this.nextRequest++}`
    return new Promise((resolve, reject) => {
      const wait: ControlWait = { resolve, reject }
      if (timeoutMs !== undefined) {
        wait.timer = setTimeout(() => {
          this.controlWaits.delete(id)
          const seconds = Math.max(1, Math.round(timeoutMs / 1000))
          reject(new AcpRequestError(RPC_ERROR.internal, `${this.name} did not get ready within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`, { hint: 'Try again. If it keeps happening, start it once in a terminal to see what it says.' }))
        }, timeoutMs)
        wait.timer.unref?.()
      }
      this.controlWaits.set(id, wait)
      this.send(controlRequest(id, request))
    })
  }

  // -- What the client asks -------------------------------------------------------------------

  private async clientRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': return this.handleInitialize()
      case 'session/new': return this.handleNewSession()
      case 'session/set_mode': return this.handleSetMode(params)
      case 'session/prompt': return this.handlePrompt(params)
      default: throw new AcpRequestError(RPC_ERROR.methodNotFound, `Method not found: ${method}`)
    }
  }

  private async handleInitialize(): Promise<unknown> {
    const { account } = await this.initialized
    if (isSignedOut(account)) throw new AcpRequestError(RPC_ERROR.internal, `${this.name} is not signed in.`, { hint: SIGN_IN_HINT })
    return {
      protocolVersion: ACP_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      agentInfo: { name: 'claude-code', title: this.name },
      // Claude Code signs in by itself, outside Cubex: nothing here for the client to start.
      authMethods: []
    }
  }

  private handleNewSession(): unknown {
    if (this.sessionId) throw new AcpRequestError(RPC_ERROR.invalidParams, 'This agent has one session, and it is open.')
    this.sessionId = randomUUID()
    return {
      sessionId: this.sessionId,
      // One mode, and the name says what it is: Claude Code asks before it edits, runs or fetches. The policy answers.
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default', description: 'Asks before it edits files, runs commands or fetches pages.' }] }
    }
  }

  private handleSetMode(params: unknown): unknown {
    const modeId = isRecord(params) ? params.modeId : undefined
    if (modeId !== 'default') throw new AcpRequestError(RPC_ERROR.invalidParams, 'The only mode is "default".')
    return {}
  }

  private handlePrompt(params: unknown): Promise<unknown> {
    const request = isRecord(params) ? params : {}
    if (!this.sessionId || request.sessionId !== this.sessionId) return Promise.reject(new AcpRequestError(RPC_ERROR.invalidParams, 'There is no such session.'))
    if (this.turn) return Promise.reject(new AcpRequestError(RPC_ERROR.invalidParams, `${this.name} is still answering another message.`))
    if (this.ended) return Promise.reject(new AcpRequestError(RPC_ERROR.internal, `${this.name} is no longer running.`))
    const blocks = Array.isArray(request.prompt) ? request.prompt : []
    const text = blocks.map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n\n')
    if (!text.trim()) return Promise.reject(new AcpRequestError(RPC_ERROR.invalidParams, 'The message has no text.'))
    return new Promise((resolve, reject) => {
      this.turn = { resolve, reject, cancelled: false, tools: new Map() }
      // A message that starts with a slash would be read as one of Claude Code's own commands.
      this.send(userMessage(/^\s*\//.test(text) ? `Message: ${text}` : text))
    })
  }

  /** `session/cancel`: stop the turn, and answer what Claude Code is waiting to hear so that it can. */
  private cancel(): void {
    const turn = this.turn
    if (!turn || turn.cancelled) return
    turn.cancelled = true
    this.send(controlRequest(`cubex_${this.nextRequest++}`, { subtype: 'interrupt' }))
    for (const id of this.questions) this.send(denyTool(id, DENIED))
    this.questions.clear()
  }

  private clientClosed(): void {
    if (this.ended) return
    try { this.claude.stdin?.end() } catch { /* already closed */ }
    const timer = setTimeout(() => { if (!this.ended) this.stop(false) }, this.options.closeGraceMs ?? CLOSE_GRACE_MS)
    timer.unref?.()
  }

  // -- What Claude Code says -------------------------------------------------------------------

  private read(line: string): void {
    if (!line.trim()) return
    const message = parseMessage(line)
    if (!message) {
      this.ignored++
      return
    }
    switch (message.type) {
      case 'control_response': this.controlResponse(message); break
      case 'control_request': this.controlRequestFromClaude(message); break
      case 'control_cancel_request': this.withdrawn(message); break
      case 'assistant': this.assistant(message); break
      case 'user': this.toolResults(message); break
      case 'result': this.result(message); break
      // system, stream_event, keep_alive, rate_limit_event and whatever a later version adds: nothing here needs them.
      default: break
    }
  }

  private controlResponse(message: Record<string, unknown>): void {
    const response = isRecord(message.response) ? message.response : {}
    const id = typeof response.request_id === 'string' ? response.request_id : undefined
    const wait = id === undefined ? undefined : this.controlWaits.get(id)
    if (!id || !wait) return
    this.controlWaits.delete(id)
    clearTimeout(wait.timer)
    if (response.subtype === 'error') {
      const text = typeof response.error === 'string' ? response.error : 'The request failed.'
      wait.reject(new AcpRequestError(RPC_ERROR.internal, tail(cleanOutput(text), 300) || `${this.name} reported an error.`))
    } else {
      wait.resolve(isRecord(response.response) ? response.response : {})
    }
  }

  private controlRequestFromClaude(message: Record<string, unknown>): void {
    const id = typeof message.request_id === 'string' ? message.request_id : undefined
    const request = isRecord(message.request) ? message.request : {}
    if (!id) return
    if (request.subtype === 'can_use_tool') {
      void this.question(id, request)
      return
    }
    const subtype = typeof request.subtype === 'string' ? request.subtype.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40) : 'unknown'
    this.send(refuseRequest(id, `Cubex does not handle "${subtype}" requests.`))
  }

  private withdrawn(message: Record<string, unknown>): void {
    if (typeof message.request_id === 'string') this.questions.delete(message.request_id)
  }

  /** Claude Code wants to use a tool: the client's policy answers. Only this once, and only with a choice Cubex offered. */
  private async question(id: string, request: Record<string, unknown>): Promise<void> {
    const turn = this.turn
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : ''
    const input = isRecord(request.input) ? request.input : {}
    if (!turn || !this.sessionId) {
      this.send(denyTool(id, 'There is no message waiting for this.'))
      return
    }
    const toolCallId = typeof request.tool_use_id === 'string' && request.tool_use_id ? request.tool_use_id : id
    const info = describeTool(toolName, input, { cwd: this.cwd })
    const state = turn.tools.get(toolCallId) ?? this.remember(turn, toolCallId, info)
    state.asked = true
    this.questions.add(id)
    let allowed = false
    try {
      const answer = await this.connection.request('session/request_permission', {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId,
          title: info.title,
          kind: info.kind,
          status: 'pending',
          ...(info.locations ? { locations: info.locations } : {}),
          ...(info.content ? { content: info.content } : {}),
          rawInput: info.rawInput
        },
        options: [
          { optionId: ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
          { optionId: REJECT_ONCE, name: 'Reject', kind: 'reject_once' }
        ]
      })
      const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : {}
      allowed = outcome.outcome === 'selected' && outcome.optionId === ALLOW_ONCE
    } catch {
      allowed = false
    }
    // Claude Code withdrew the question, or it was answered when the turn was cancelled.
    if (!this.questions.delete(id)) return
    this.send(allowed ? allowTool(id, input) : denyTool(id, DENIED))
  }

  private remember(turn: Turn, id: string, info: ToolInfo): ToolState {
    if (turn.tools.size >= MAX_TOOLS_REMEMBERED) turn.tools.delete(turn.tools.keys().next().value as string)
    const state: ToolState = { info, asked: false }
    turn.tools.set(id, state)
    return state
  }

  private update(update: Record<string, unknown>): void {
    if (this.ended || !this.sessionId) return
    this.connection.notify('session/update', { sessionId: this.sessionId, update })
  }

  private assistant(message: Record<string, unknown>): void {
    const turn = this.turn
    // A subagent's words are not the reply. None are offered, so this is a program doing more than it was asked.
    if (!turn || message.parent_tool_use_id) return
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id && typeof block.name === 'string') {
        const info = describeTool(block.name, isRecord(block.input) ? block.input : {}, { cwd: this.cwd })
        const existing = turn.tools.get(block.id)
        if (!existing) this.remember(turn, block.id, info)
        this.update({
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: info.title,
          kind: info.kind,
          status: 'pending',
          ...(info.locations ? { locations: info.locations } : {}),
          rawInput: info.rawInput
        })
      }
    }
  }

  /** The results of tools, which come back as a message from the user. */
  private toolResults(message: Record<string, unknown>): void {
    const turn = this.turn
    if (!turn || message.parent_tool_use_id) return
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : []
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const failed = block.is_error === true
      this.update({ sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id, status: failed ? 'failed' : 'completed' })
      const state = turn.tools.get(block.tool_use_id)
      if (state && !failed && !state.asked && ASKED_ABOUT.has(state.info.kind)) this.unasked(turn, state)
    }
  }

  /**
   * A tool that changes something, or reaches out, ran and Cubex was never asked. The question is the only thing that holds
   * Claude Code to the chat's permission mode, so it is not held to it any more: the turn ends and so does the program.
   */
  private unasked(turn: Turn, state: ToolState): void {
    if (turn.stopped) return
    const what = oneLine(state.info.title, 80)
    turn.stopped = new AcpRequestError(RPC_ERROR.internal, `${this.name} did this without asking: ${what}. Cubex cannot hold it to your permission mode, so it was stopped.`, {
      hint: 'Check that nothing in your Claude Code setup, such as a managed policy, allows tools without asking. Cubex asks about every tool when it starts Claude Code.'
    })
    this.stop(false)
  }

  private result(message: Record<string, unknown>): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    this.questions.clear()
    if (turn.stopped) {
      turn.reject(turn.stopped)
      return
    }
    if (turn.cancelled) {
      turn.resolve({ stopReason: 'cancelled' })
      return
    }
    const subtype = typeof message.subtype === 'string' ? message.subtype : 'success'
    if (subtype === 'error_max_turns') {
      turn.resolve({ stopReason: 'max_turn_requests' })
      return
    }
    if (message.is_error === true || subtype.startsWith('error')) {
      turn.reject(this.errorOf(message, subtype))
      return
    }
    turn.resolve({ stopReason: stopReasonOf(message) })
  }

  /** What went wrong, from a result that says it did. Claude Code reports a missing login as an ordinary result. */
  private errorOf(message: Record<string, unknown>, subtype: string): AcpRequestError {
    const said = typeof message.result === 'string' ? message.result : Array.isArray(message.errors) ? message.errors.filter((entry) => typeof entry === 'string').join('\n') : ''
    if (looksSignedOut(said)) return new AcpRequestError(RPC_ERROR.internal, `${this.name} is not signed in, or its sign-in has expired.`, { hint: SIGN_IN_HINT })
    const clean = tail(cleanOutput(said), 400)
    return new AcpRequestError(RPC_ERROR.internal, clean ? `${this.name} stopped with an error: ${clean}` : `${this.name} stopped with an error (${subtype.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 60)}).`)
  }

  // -- Ending -------------------------------------------------------------------------------------

  /** Stop Claude Code and what it started. */
  stop(sync: boolean): void {
    if (this.ended) return
    this.claude.stop(sync)
    this.end({ kind: 'close', code: null })
  }

  /** Claude Code is gone, or Cubex ended it: whatever waits for it fails with the reason, and the client hears that it is over. */
  private end(outcome: ProcessOutcome): void {
    if (this.ended) return
    this.ended = true
    const reason = this.goneBecause(outcome)
    for (const wait of this.controlWaits.values()) {
      clearTimeout(wait.timer)
      wait.reject(reason)
    }
    this.controlWaits.clear()
    this.questions.clear()
    const turn = this.turn
    this.turn = undefined
    turn?.reject(turn.stopped ?? reason)
    try { this.options.cleanup?.() } catch { /* a folder that cannot be removed now is swept later */ }
    this.errors.end()
    finishOutput(this.toClient, outcome, this.settle)
  }

  private goneBecause(outcome: ProcessOutcome): AcpRequestError {
    if (outcome.kind === 'error') return new AcpRequestError(RPC_ERROR.internal, `${this.name} could not be started: ${outcome.error.message}`)
    const code = outcome.code === null ? '' : ` with exit code ${outcome.code}`
    const hint = failureHint(cleanOutput(this.stderrTail), outcome.code)
    return new AcpRequestError(RPC_ERROR.internal, `${this.name} stopped unexpectedly${code}.`, hint ? { hint } : undefined)
  }
}
