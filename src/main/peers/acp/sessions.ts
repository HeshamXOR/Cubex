import { statSync } from 'node:fs'
import type { AcpPeer } from '@shared/peers'
import { consultFollowUp, consultPrompt, fitPrompt } from '../framing'
import { cleanOutput, clipReply } from '../output'
import { createScratch, removeScratch, STDIN_PROMPT_LIMIT, type PeerRun } from '../peerRunner'
import type { Exchange } from '../transcript'
import { AcpAgent, AcpFailure, type AcpAgentLike, type AcpReply, type OpenOptions } from './agent'
import { readinessNote } from './modes'

/**
 * The agents Cubex keeps running between messages. A consulted agent that speaks ACP keeps its session, so the second
 * message of a talk reaches an agent that remembers the first and a start costs nothing the second time. Each task has
 * one session per agent. It is started by the first message, answers one message at a time, and is stopped when the
 * task has not used it for a while, when the task is deleted, when the agent's settings change, when it fails, and when
 * the app quits. A session that was stopped is started again by the next message, which carries the talk so far.
 */

export const SESSION_IDLE_MS = 10 * 60_000
/** Most agents kept running at once: each is a whole program, often with a language model behind it. */
export const MAX_LIVE_SESSIONS = 4

export interface AcpAsk {
  conversationId: string
  /** The task's project folder, when it has one. */
  workspace?: string
  /** The talk with this agent so far, for a session that has to be started again. */
  history: readonly Exchange[]
  message: string
}

export interface AcpRunOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface AcpSessionsOptions {
  idleMs?: number
  maxLive?: number
  /** Replaces the start of a real program. For tests. */
  open?: (options: OpenOptions) => Promise<AcpAgentLike>
  scratch?: { create: () => string; remove: (folder: string) => void }
  env?: NodeJS.ProcessEnv
}

/** What the agent said, as a run of the consult tool: clean text, and a note when the agent was cut short. */
export function acpRun(peer: AcpPeer, reply: AcpReply, started: number): PeerRun {
  const durationMs = Date.now() - started
  const failed = (error: string, hint?: string): PeerRun => ({ ok: false, reply: '', error, ...(hint ? { hint } : {}), durationMs })
  if (reply.stopReason === 'refusal') return failed(`${peer.name} declined to answer.`)
  const text = cleanOutput(reply.text)
  if (!text) {
    if (reply.stopReason === 'max_turn_requests') return failed(`${peer.name} used all the steps it is allowed and did not reply.`, 'Ask a smaller question.')
    return failed(`${peer.name} finished without a reply.`, 'Check that the program speaks the Agent Client Protocol, and that it is signed in.')
  }
  const cut = reply.stopReason === 'max_tokens' || reply.capped
  return { ok: true, reply: cut ? `${clipReply(text)}\n[The agent was cut short, so this reply may be incomplete.]` : text, durationMs }
}

/** A failure as a run of the consult tool. */
export function acpFailed(error: unknown, started: number): PeerRun {
  const durationMs = Date.now() - started
  if (error instanceof AcpFailure) {
    return { ok: false, reply: '', error: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.output ? { output: error.output } : {}), durationMs }
  }
  return { ok: false, reply: '', error: error instanceof Error ? error.message : String(error), durationMs }
}

interface Entry {
  key: string
  conversationId: string
  /** The kind of agent it is, so the sessions of one kind can be stopped together. */
  preset: string
  /** What the session was started with. A session started differently is not reused. */
  signature: string
  agent?: AcpAgentLike
  /** The empty folder the agent was started in, when it may not see the project. */
  scratch?: string
  /** The messages wait in line here: a session answers one at a time. */
  tail: Promise<void>
  idle?: ReturnType<typeof setTimeout>
  busy: number
  lastUsed: number
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

export class AcpSessions {
  private readonly entries = new Map<string, Entry>()
  private disposed = false
  private readonly idleMs: number
  private readonly maxLive: number
  private readonly open: (options: OpenOptions) => Promise<AcpAgentLike>
  private readonly scratch: { create: () => string; remove: (folder: string) => void }
  private readonly env: NodeJS.ProcessEnv | undefined

  constructor(options: AcpSessionsOptions = {}) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS
    this.maxLive = options.maxLive ?? MAX_LIVE_SESSIONS
    this.open = options.open ?? ((spec) => AcpAgent.open(spec))
    this.scratch = options.scratch ?? { create: createScratch, remove: removeScratch }
    this.env = options.env
  }

  /** How many sessions are running. */
  get live(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.agent?.alive) count++
    return count
  }

  /** Send one message to an agent in a task, starting its session if there is none. Never rejects. */
  ask(peer: AcpPeer, ask: AcpAsk, run: AcpRunOptions = {}): Promise<PeerRun> {
    const started = Date.now()
    if (this.disposed) return Promise.resolve(acpFailed(new AcpFailure('Cubex is closing.'), started))
    if (run.signal?.aborted) return Promise.resolve(acpFailed(new AcpFailure('Cancelled.'), started))

    const readsProject = peer.readProject === true && !!ask.workspace
    const key = `${ask.conversationId}\u0000${peer.id}`
    const signature = JSON.stringify([peer.command, peer.args ?? [], peer.passEnv ?? [], peer.authMethod ?? '', readsProject ? ask.workspace : ''])
    let entry = this.entries.get(key)
    if (entry && entry.signature !== signature) {
      this.drop(entry)
      entry = undefined
    }
    if (!entry) {
      entry = { key, conversationId: ask.conversationId, preset: peer.preset, signature, tail: Promise.resolve(), busy: 0, lastUsed: Date.now() }
      this.entries.set(key, entry)
    }
    const mine = entry
    const turn = mine.tail.then(() => this.turn(mine, peer, ask, readsProject, run, started))
    mine.tail = turn.then(() => undefined)
    return turn
  }

  /** One message in a session that is not kept: the Settings page's test. For an agent that may take tasks it also says whether it can. */
  async test(peer: AcpPeer, message: string, run: AcpRunOptions = {}): Promise<PeerRun> {
    const started = Date.now()
    const folder = this.scratch.create()
    let agent: AcpAgentLike | undefined
    try {
      agent = await this.open({ peer, cwd: folder, ...(this.env ? { env: this.env } : {}), ...(run.signal ? { signal: run.signal } : {}) })
      const answer = acpRun(peer, await agent.prompt(consultPrompt([], message, false), run), started)
      const readiness = answer.ok && peer.canDelegate === true ? agent.taskReadiness?.() : undefined
      return readiness ? { ...answer, note: readinessNote(readiness) } : answer
    } catch (error) {
      return acpFailed(error, started)
    } finally {
      if (agent) await agent.close().catch(() => undefined)
      this.scratch.remove(folder)
    }
  }

  /** Stop the agents of a task, which was deleted. */
  forgetConversation(conversationId: string): void {
    for (const entry of [...this.entries.values()]) if (entry.conversationId === conversationId) this.drop(entry)
  }

  /**
   * Stop the agents of one kind, in every task: something they all depend on was removed or changed, such as the sign-in they hold in
   * memory. A message that was waiting for one fails as it would for an agent that stopped; the next message starts a new session.
   */
  endPreset(preset: string): void {
    for (const entry of [...this.entries.values()]) if (entry.preset === preset) this.drop(entry)
  }

  /** Stop everything, now and for good: the app is quitting. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      clearTimeout(entry.idle)
      const { agent, scratch } = entry
      entry.agent = undefined
      entry.scratch = undefined
      try { agent?.kill(true) } catch { /* already gone */ }
      if (scratch) this.scratch.remove(scratch)
    }
    this.entries.clear()
  }

  // -- One message ---------------------------------------------------------------------

  private async turn(entry: Entry, peer: AcpPeer, ask: AcpAsk, readsProject: boolean, run: AcpRunOptions, started: number): Promise<PeerRun> {
    if (this.disposed) return acpFailed(new AcpFailure('Cubex is closing.'), started)
    if (run.signal?.aborted) return acpFailed(new AcpFailure('Cancelled.'), started)
    entry.busy++
    clearTimeout(entry.idle)
    try {
      let fresh = false
      if (!entry.agent?.alive) {
        this.release(entry, 'kill')
        if (readsProject && !isDirectory(ask.workspace!)) throw new AcpFailure('The project folder was not found, so the agent cannot read it.')
        const cwd = readsProject ? ask.workspace! : (entry.scratch = this.scratch.create())
        entry.agent = await this.open({ peer, cwd, ...(this.env ? { env: this.env } : {}), ...(run.signal ? { signal: run.signal } : {}) })
        fresh = true
        this.trim(entry)
      }
      const prompt = fresh ? fitPrompt(ask.history, ask.message, readsProject, STDIN_PROMPT_LIMIT) : consultFollowUp(ask.message)
      if (!prompt) throw new AcpFailure(`The message is too long to send to ${peer.name}. Send a shorter one.`)
      return acpRun(peer, await entry.agent!.prompt(prompt, run), started)
    } catch (error) {
      // A session that failed, was cancelled or timed out is in no state to be asked again.
      this.release(entry, 'kill')
      return acpFailed(error, started)
    } finally {
      entry.busy--
      entry.lastUsed = Date.now()
      if (entry.agent?.alive && entry.busy === 0 && !this.disposed) this.arm(entry)
    }
  }

  // -- Keeping and stopping --------------------------------------------------------------

  private arm(entry: Entry): void {
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (entry.busy > 0) return this.arm(entry)
      this.drop(entry, 'close')
    }, this.idleMs)
    entry.idle.unref?.()
  }

  /** Forget an entry and stop its agent. */
  private drop(entry: Entry, how: 'kill' | 'close' = 'kill'): void {
    clearTimeout(entry.idle)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    this.release(entry, how)
  }

  /** Stop the agent of an entry and remove the folder it started in. `close` lets it end by itself first. */
  private release(entry: Entry, how: 'kill' | 'close'): void {
    const { agent, scratch } = entry
    entry.agent = undefined
    entry.scratch = undefined
    if (agent) {
      if (how === 'close') void agent.close().catch(() => undefined).finally(() => { if (scratch) this.scratch.remove(scratch) })
      else {
        try { agent.kill() } catch { /* already gone */ }
        if (scratch) this.scratch.remove(scratch)
      }
    } else if (scratch) this.scratch.remove(scratch)
  }

  /** Over the limit, the one that has been quiet longest goes. A session that is answering is never the one. */
  private trim(keep: Entry): void {
    while (this.live > this.maxLive) {
      let oldest: Entry | undefined
      for (const entry of this.entries.values()) {
        if (entry === keep || entry.busy > 0 || !entry.agent?.alive) continue
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
      }
      if (!oldest) return
      this.drop(oldest, 'close')
    }
  }
}
