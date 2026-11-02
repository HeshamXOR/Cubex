import { PassThrough } from 'node:stream'
import { RPC_ERROR } from '../acp/connection'
import { isRecord, LineSplitter, parseMessage } from '../acp/lines'
import { finishOutput, latchedProcess, type AcpProcess, type ProcessOutcome } from '../acp/process'
import { authorizationUrlIn, SIGN_IN_FIRST, SIGN_IN_FIRST_HINT, SIGN_IN_PAGE_REFUSED, SIGN_IN_PAGE_REFUSED_HINT, type AuthorizationRequest } from './profile'
import { isInteraction, normalizePermissionRequest, normalizeSessionUpdate, onlyPersonalSignIn } from './wire'

/**
 * Sits between Cubex and Google's Antigravity runtime, on the lines they send each other, and does four things the rest of Cubex
 * cannot know to do:
 *
 *  - It keeps the runtime from asking the person to sign in from inside a chat. When the runtime reports the address of Google's
 *    sign-in page and nobody asked to sign in, the chat's request fails with "not signed in" and the runtime is stopped. Signing
 *    in is its own action, in Settings, and then the address goes to whoever asked for it and the runtime waits.
 *  - It answers the runtime's questions for the person (the permission method also carries those, named "interaction_...") with
 *    "cancelled": a question is not a permission, and picking one of its answers would be speaking for the person.
 *  - It puts the runtime's tool calls in the shape the rest of Cubex reads (the command under one name, sizes bounded).
 *  - It offers only the way to sign in that Cubex uses, so the client does not have to choose between several.
 *
 * Everything else passes through as it was sent. It speaks for neither side beyond that.
 */

const CLOSE_GRACE_MS = 3_000
/** After the runtime was stopped, how long to wait for it to be gone before what its run held is given up anyway. */
const EXIT_WAIT_MS = 3_000
const PERMISSION = 'session/request_permission'

export interface FilterOptions {
  /** Google's runtime, started with its profile and environment. */
  runtime: AcpProcess
  /** What the person sees it called, in messages. */
  name?: string
  /** Whether the runtime has a saved sign-in. */
  signedIn: () => boolean
  /** Signing in: the address of Google's sign-in page goes here, and the runtime goes on waiting for the person. Absent in a chat. */
  onAuthorizationUrl?: (request: AuthorizationRequest) => void
  /** After the end of its input, how long the runtime has to exit before it is stopped. */
  closeGraceMs?: number
  /** After the runtime was stopped, how long to wait for it to be gone before the cleanup runs anyway. */
  exitWaitMs?: number
  /**
   * Called once when the runtime is gone, to give up what its run held: its folder and its place in the release it runs from. A
   * runtime that was told to stop is still holding both for a moment, so this waits for it to be gone, and no longer than `exitWaitMs`.
   */
  cleanup?: () => void
}

type Id = number | string

function isId(value: unknown): value is Id {
  return typeof value === 'number' || typeof value === 'string'
}

export class AntigravityFilter {
  /** What the client holds in place of the runtime. */
  readonly process: AcpProcess
  private readonly fromClient = new PassThrough()
  private readonly toClient = new PassThrough()
  private readonly errors = new PassThrough()
  private readonly settle: (outcome: ProcessOutcome) => void
  private readonly runtime: AcpProcess
  private readonly clientLines: LineSplitter
  private readonly runtimeLines: LineSplitter
  private readonly runtimeErrors: LineSplitter
  /** What the client asked and has not had an answer to, by id. */
  private readonly asked = new Map<Id, string>()
  private readonly reported = new Set<string>()
  private ended = false
  private stopping = false
  /** The runtime itself reported that it is over, or was stopped in a way that returns when it is dead. */
  private runtimeGone = false
  private cleaned = false
  private cleanupTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: FilterOptions) {
    this.runtime = options.runtime
    const made = latchedProcess({ stdin: this.fromClient, stdout: this.toClient, stderr: this.errors }, (sync) => this.stop(sync))
    this.process = made.process
    this.settle = made.settle

    this.fromClient.setEncoding('utf8')
    this.clientLines = new LineSplitter((line) => this.fromClientLine(line))
    this.fromClient.on('data', (chunk: string) => this.clientLines.push(chunk))
    this.fromClient.on('end', () => {
      this.clientLines.end()
      this.clientClosed()
    })
    this.fromClient.on('error', () => undefined)
    this.toClient.on('error', () => undefined)

    this.runtimeLines = new LineSplitter((line) => this.runtimeLine(line))
    this.runtimeErrors = new LineSplitter((line) => this.runtimeErrorLine(line))
    const { stdout, stderr, stdin } = options.runtime
    stdout?.setEncoding('utf8')
    stdout?.on('data', (chunk: string) => this.runtimeLines.push(chunk))
    stdout?.on('end', () => this.runtimeLines.end())
    stdout?.on('error', () => undefined)
    stderr?.setEncoding('utf8')
    stderr?.on('data', (chunk: string) => this.runtimeErrors.push(chunk))
    stderr?.on('end', () => this.runtimeErrors.end())
    stderr?.on('error', () => undefined)
    stdin?.on('error', () => undefined)
    options.runtime.once('error', (error) => this.runtimeOver({ kind: 'error', error }))
    options.runtime.once('close', (code) => this.runtimeOver({ kind: 'close', code }))
  }

  private get name(): string {
    return this.options.name ?? 'Antigravity'
  }

  // -- What the client says ------------------------------------------------------------------

  private fromClientLine(line: string): void {
    if (!line.trim()) return
    const message = parseMessage(line)
    // A request is remembered until it is answered, so that a failure can answer it.
    if (message && typeof message.method === 'string' && isId(message.id)) this.asked.set(message.id, message.method)
    this.toRuntime(line)
  }

  private toRuntime(text: string): void {
    if (this.ended) return
    try {
      this.runtime.stdin?.write(`${text}\n`)
    } catch {
      // The pipe is closed: the runtime's exit reports it.
    }
  }

  private clientClosed(): void {
    if (this.ended) return
    try { this.runtime.stdin?.end() } catch { /* already closed */ }
    const timer = setTimeout(() => { if (!this.ended) this.stop(false) }, this.options.closeGraceMs ?? CLOSE_GRACE_MS)
    timer.unref?.()
  }

  // -- What the runtime says -----------------------------------------------------------------

  private toTheClient(message: unknown): void {
    if (this.ended) return
    this.toClient.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  }

  private runtimeLine(line: string): void {
    if (!line.trim()) return
    const message = parseMessage(line)
    if (!message) {
      // Not a message: if it is the address of the sign-in page it is handled here, and anything else goes on as it was.
      const found = authorizationUrlIn(line)
      if (found.found) this.signInReported(found.request)
      else this.toTheClient(line)
      return
    }
    if (typeof message.method === 'string') {
      this.runtimeRequest(line, message)
      return
    }
    if (isId(message.id) && ('result' in message || 'error' in message)) {
      this.runtimeAnswer(line, message, message.id)
      return
    }
    this.toTheClient(line)
  }

  /** What the runtime sends that is not an answer: an update, or a request for the client. */
  private runtimeRequest(line: string, message: Record<string, unknown>): void {
    if (message.method === 'session/update') {
      const params = normalizeSessionUpdate(message.params)
      this.toTheClient(params === message.params ? line : { ...message, params })
      return
    }
    if (message.method === PERMISSION && isId(message.id)) {
      if (isInteraction(message.params)) {
        // A question for the person is not a permission: it is not answered for them.
        this.toRuntime(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }))
        return
      }
      this.toTheClient({ ...message, params: normalizePermissionRequest(message.params) })
      return
    }
    this.toTheClient(line)
  }

  private runtimeAnswer(line: string, message: Record<string, unknown>, id: Id): void {
    const method = this.asked.get(id)
    this.asked.delete(id)
    if (method === 'initialize' && 'result' in message) {
      this.toTheClient({ ...message, result: onlyPersonalSignIn(message.result) })
      return
    }
    // A chat that has no saved sign-in to use is told so in words, which is not the runtime's "authentication required": that
    // would make the client ask the runtime to start signing in.
    const error = isRecord(message.error) ? message.error : undefined
    if (method === 'session/new' && error && error.code === RPC_ERROR.authRequired && !this.options.onAuthorizationUrl && !this.options.signedIn()) {
      this.toTheClient({ jsonrpc: '2.0', id, error: this.signInError() })
      return
    }
    this.toTheClient(line)
  }

  private runtimeErrorLine(line: string): void {
    if (!line.trim()) return
    const found = authorizationUrlIn(line)
    if (found.found) {
      this.signInReported(found.request)
      return
    }
    if (!this.ended) this.errors.write(`${line}\n`)
  }

  // -- Signing in -----------------------------------------------------------------------------

  private signInError(): { code: number; message: string; data: { hint: string } } {
    return { code: RPC_ERROR.internal, message: SIGN_IN_FIRST.replace('Antigravity', this.name), data: { hint: SIGN_IN_FIRST_HINT } }
  }

  /** Fails everything the client is waiting for with the same error, says why on the error output, and stops the runtime. */
  private failWaiting(error: { code: number; message: string; data: { hint: string } }): void {
    if (this.ended || this.stopping) return
    this.stopping = true
    for (const id of this.asked.keys()) this.toTheClient({ jsonrpc: '2.0', id, error })
    this.asked.clear()
    if (!this.ended) this.errors.write(`${error.message}\n`)
    this.stop(false)
  }

  /** The runtime reported the address of Google's sign-in page, or something that was meant to be and is not. */
  private signInReported(request: AuthorizationRequest | undefined): void {
    if (this.options.onAuthorizationUrl) {
      if (!request) {
        // Not Google's page, so it is not opened. When no page of Google's was reported before it, nothing is gained by waiting for
        // one; when one was, the person may be signing in on it, and a stray line does not end that.
        if (this.reported.size === 0) {
          this.failWaiting({ code: RPC_ERROR.internal, message: SIGN_IN_PAGE_REFUSED.replace('Antigravity', this.name), data: { hint: SIGN_IN_PAGE_REFUSED_HINT } })
        }
        return
      }
      if (!this.reported.has(request.authorizationUrl)) {
        this.reported.add(request.authorizationUrl)
        this.options.onAuthorizationUrl(request)
      }
      return
    }
    // A chat does not sign anyone in. What waits is told why, and the runtime is stopped.
    this.failWaiting(this.signInError())
  }

  // -- Ending ----------------------------------------------------------------------------------

  /** Stop the runtime and what it started. */
  stop(sync: boolean): void {
    if (this.ended) return
    this.runtime.stop(sync)
    // A stop that waits returns when the runtime is dead. One that does not leaves it dying: its own end says when it is gone.
    if (sync) this.runtimeGone = true
    this.end({ kind: 'close', code: null })
  }

  /** The runtime ended by itself, or the stop that was asked for finished. */
  private runtimeOver(outcome: ProcessOutcome): void {
    this.runtimeGone = true
    this.end(outcome)
    this.cleanUp()
  }

  private end(outcome: ProcessOutcome): void {
    if (this.ended) return
    this.ended = true
    this.asked.clear()
    this.errors.end()
    finishOutput(this.toClient, outcome, this.settle)
    if (this.runtimeGone) {
      this.cleanUp()
    } else {
      // The client has been told. What the run held is kept until the runtime is gone, or until it has had long enough.
      this.cleanupTimer = setTimeout(() => this.cleanUp(), this.options.exitWaitMs ?? EXIT_WAIT_MS)
      this.cleanupTimer.unref?.()
    }
  }

  private cleanUp(): void {
    if (this.cleaned) return
    this.cleaned = true
    clearTimeout(this.cleanupTimer)
    try { this.options.cleanup?.() } catch { /* a folder that cannot be removed now is swept later */ }
  }
}
