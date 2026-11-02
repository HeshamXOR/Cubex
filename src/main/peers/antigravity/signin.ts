import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDLE_SIGN_IN, signInIsRunning, type AntigravityActionResult, type AntigravitySignInState } from '@shared/antigravity'
import { newAcpPeer } from '@shared/peers'
import type { LaunchInput, LaunchPlan } from '../../mcp/resolveLaunch'
import { AcpAgent, AcpFailure, type OpenOptions } from '../acp/agent'
import { AcpRequestError } from '../acp/connection'
import { isRecord } from '../acp/lines'
import { cleanOutput, tail } from '../output'
import { peerEnvironment } from '../peerRunner'
import type { AntigravityInstaller } from './install'
import { hasSavedSignIn, SIGN_IN_PAGE_REFUSED, SIGN_IN_PAGE_REFUSED_HINT, type AuthorizationRequest } from './profile'
import { DEFAULT_RUNTIME_COMMAND, antigravityContext, resolveRuntime, startAntigravityWith, withRuntime } from './runtime'

/**
 * Signing in to Antigravity with a Google account, and signing out. Signing in starts the runtime the way a chat would and lets
 * it ask for the sign-in: the address of Google's sign-in page, which the filter checks is Google's, is opened in the browser, and
 * the runtime, listening on this computer, receives Google's answer by itself. Cubex never sees the page, the code or the token,
 * and never reads the file the runtime saves the sign-in in; it only asks the runtime to forget it when the person signs out.
 * Ported from the T3 Code project (github.com/pingdotgg/t3code, MIT licence, Copyright (c) 2026 T3 Tools Inc.); see
 * THIRD_PARTY_NOTICES.md.
 */

/** How long the person has to finish signing in on Google's page. */
export const SIGN_IN_TIMEOUT_MS = 300_000
const SIGN_OUT_TIMEOUT_MS = 90_000
/** How long a sign-in that ended waits for the runtime to be gone before it removes the folder the runtime worked in. */
const RUNTIME_EXIT_WAIT_MS = 5_000

/** The reason a sign-in failed, in a sentence for the person. The runtime and Google word these their own way, so a miss is the plain one. */
export function signInFailure(error: unknown): string {
  const text = error instanceof AcpFailure || error instanceof AcpRequestError || error instanceof Error ? error.message : String(error)
  if (/SUBSCRIPTION_REQUIRED/i.test(text)) return 'Google requires an eligible Antigravity subscription for this account.'
  if (/sign-in page that is not Google's/i.test(text)) return `${SIGN_IN_PAGE_REFUSED} ${SIGN_IN_PAGE_REFUSED_HINT}`
  if (/access_denied|denied access|cancelled/i.test(text)) return 'Google sign-in was not approved. Start sign-in again.'
  if (/did not get ready within|took too long|expired/i.test(text)) return 'Google sign-in expired. Start sign-in again.'
  if (/is not installed|was not found|not publish/i.test(text)) return cleanOutput(text)
  if (/could not initialize|load models|internal error/i.test(text)) return 'Antigravity signed in, but could not start a session or load its models.'
  return 'Google sign-in failed. Start sign-in again.'
}

type Listener = (state: AntigravitySignInState) => void

interface Flow {
  id: string
  controller: AbortController
  opened: boolean
  /** Ended by the person: what comes after is not reported. */
  ended: boolean
  done: Promise<void>
}

export interface SignInOptions {
  installer: AntigravityInstaller
  /** Opens an address in the browser. It is only ever called with an address Google's own sign-in page has. */
  open: (url: string) => void
  /** Where PATH and the variables to pass are read from. */
  env?: NodeJS.ProcessEnv
  helperExecutable: string
  timeoutMs?: number
  /** Replaces the lookup that decides how to start a program. For tests. */
  launch?: ((input: LaunchInput) => LaunchPlan) | undefined
  /** Replaces how the agent is opened. For tests. */
  openAgent?: (options: OpenOptions) => Promise<{ close(): Promise<void> }>
}

export class AntigravitySignIn {
  private current: AntigravitySignInState = IDLE_SIGN_IN
  private flow: Flow | undefined
  private signingOut = false
  private readonly listeners = new Set<Listener>()

  constructor(private readonly options: SignInOptions) {}

  get state(): AntigravitySignInState {
    return this.current
  }

  get busy(): boolean {
    return this.flow !== undefined || this.signingOut
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: AntigravitySignInState): void {
    this.current = next
    for (const listener of [...this.listeners]) {
      try { listener(next) } catch { /* a window that is gone must not stop a sign-in */ }
    }
  }

  /** Starts signing in. A sign-in that is going is the one returned. */
  start(): AntigravitySignInState {
    if (this.flow) return this.current
    if (this.signingOut) throw new AcpFailure('Antigravity is signing out. Try again when it has finished.')
    const timeoutMs = this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS
    const controller = new AbortController()
    const flow: Flow = { id: randomUUID(), controller, opened: false, ended: false, done: Promise.resolve() }
    this.flow = flow
    this.publish({ phase: 'starting', flowId: flow.id, authorizationUrl: null, expiresAt: Date.now() + timeoutMs, message: 'Starting Google sign-in.' })
    flow.done = this.run(flow, timeoutMs)
    return this.current
  }

  /** Resolves when the sign-in that is going has ended, however it ended. */
  async finished(): Promise<void> {
    await this.flow?.done
  }

  cancel(flowId: string): AntigravitySignInState {
    const flow = this.flow
    if (!flow || flow.id !== flowId) throw new AcpFailure('This sign-in is no longer active.')
    flow.ended = true
    flow.controller.abort()
    this.flow = undefined
    this.publish({ phase: 'cancelled', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Google sign-in was cancelled.' })
    return this.current
  }

  /** Stops whatever is going: the app is quitting. */
  stop(): void {
    this.flow?.controller.abort()
    this.flow = undefined
  }

  /** The runtime reported Google's sign-in page. It is opened once, and kept in the state so that it can be opened again. */
  private received(flow: Flow, request: AuthorizationRequest): void {
    if (flow.ended || this.flow !== flow) return
    this.publish({ phase: 'waiting', flowId: flow.id, authorizationUrl: request.authorizationUrl, expiresAt: this.current.expiresAt, message: 'Google\'s sign-in page opened in your browser. Finish signing in there.' })
    if (!flow.opened) {
      flow.opened = true
      try { this.options.open(request.authorizationUrl) } catch { /* the address is in the state: the person can open it from there */ }
    }
  }

  private async run(flow: Flow, timeoutMs: number): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), 'cubex-agy-signin-'))
    // The runtime has this folder as its working directory, and Windows will not remove a folder that a program is working in.
    let gone: Promise<void> = Promise.resolve()
    try {
      const peer = newAcpPeer('agy-acp', [])
      const open = this.options.openAgent ?? ((spec: OpenOptions) => AcpAgent.open(spec))
      const agent = await open({
        peer,
        cwd: folder,
        env: this.options.env ?? peerEnvironment(peer),
        start: (input) => {
          let done!: () => void
          gone = new Promise<void>((resolve) => { done = resolve })
          try {
            return startAntigravityWith(input, { onAuthorizationUrl: (request) => this.received(flow, request), onGone: done })
          } catch (error) {
            done()
            throw error
          }
        },
        startTimeoutMs: timeoutMs,
        signal: flow.controller.signal,
        ...(this.options.launch ? { launch: this.options.launch } : {})
      })
      // The session opened, so the runtime is signed in and has its models.
      await agent.close().catch(() => undefined)
      if (flow.ended) return
      this.flow = undefined
      this.publish({ phase: 'succeeded', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Signed in with Google.' })
    } catch (error) {
      if (flow.ended) return
      this.flow = undefined
      this.publish({ phase: 'failed', flowId: null, authorizationUrl: null, expiresAt: null, message: signInFailure(error) })
    } finally {
      await Promise.race([gone, new Promise<void>((done) => setTimeout(done, RUNTIME_EXIT_WAIT_MS).unref())])
      try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept with the temporary folder */ }
    }
  }

  // -- Signing out -----------------------------------------------------------------------------

  /** Asks the runtime to forget the sign-in. The sessions that are running must be stopped first: they hold it in memory. */
  async signOut(): Promise<AntigravityActionResult> {
    const context = antigravityContext()
    if (!context) return { ok: false, message: 'Antigravity is not set up in this build of Cubex.' }
    if (this.flow) this.cancel(this.flow.id)
    if (this.signingOut) return { ok: false, message: 'Antigravity is already signing out.' }
    this.signingOut = true
    try {
      const env = this.options.env ?? peerEnvironment({})
      const executable = resolveRuntime({ command: DEFAULT_RUNTIME_COMMAND }, this.options.installer, env)
      await withRuntime({
        executable,
        profileDirectory: context.directories.profile,
        tempDirectory: context.directories.temp,
        helperExecutable: this.options.helperExecutable,
        baseEnv: env,
        launch: this.options.launch,
        installer: this.options.installer,
        timeoutMs: SIGN_OUT_TIMEOUT_MS
      }, async (connection) => {
        const init = await connection.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'cubex', title: 'Cubex', version: '0.0.0' }
        })
        const capabilities = isRecord(init) && isRecord(init.agentCapabilities) ? init.agentCapabilities : {}
        const auth = isRecord(capabilities.auth) ? capabilities.auth : {}
        if (!auth.logout) throw new AcpFailure('This version of the Antigravity runtime cannot sign out. Update it in Settings.')
        await connection.request('logout', {})
      })
      this.publish(IDLE_SIGN_IN)
      return hasSavedSignIn(context.directories.profile)
        ? { ok: false, message: 'Antigravity said it signed out, but its sign-in is still saved. Try again, or remove the runtime.' }
        : { ok: true, message: 'Signed out of Google.' }
    } catch (error) {
      const detail = error instanceof AcpFailure ? error.message : tail(cleanOutput(error instanceof Error ? error.message : String(error)), 200)
      return { ok: false, message: `Antigravity sign-out failed: ${detail || 'it did not answer'}. Try again.` }
    } finally {
      this.signingOut = false
    }
  }

  isSigningIn(): boolean {
    return signInIsRunning(this.current)
  }
}
