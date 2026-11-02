import { describe, expect, it, vi } from 'vitest'
import type { AcpPeer } from '@shared/peers'
import { AcpFailure, type AcpAgentLike, type AcpReply, type OpenOptions, type PromptOptions } from './agent'
import type { TaskReadiness } from './modes'
import { AcpSessions, type AcpAsk, type AcpSessionsOptions } from './sessions'

/** An agent that is not a program: it records what it is sent, and answers from a script. */
class FakeAgent implements AcpAgentLike {
  alive = true
  prompts: string[] = []
  closed = false
  killed: Array<boolean | undefined> = []
  readiness: TaskReadiness | undefined
  constructor(readonly options: OpenOptions, private readonly script: (prompt: string, count: number, options: PromptOptions) => Promise<AcpReply> | AcpReply) {}
  async prompt(text: string, options: PromptOptions = {}): Promise<AcpReply> {
    this.prompts.push(text)
    return this.script(text, this.prompts.length, options)
  }
  taskReadiness(): TaskReadiness { return this.readiness ?? { ready: true } }
  async close(): Promise<void> { this.alive = false; this.closed = true }
  kill(sync?: boolean): void { this.alive = false; this.killed.push(sync) }
}

const said = (text = 'Looks fine.\nVerdict: agree', stopReason = 'end_turn'): AcpReply => ({ text, stopReason, capped: false })
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Wait, without a fixed pause, for something a timer does. */
const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 3_000, interval: 10 }) as Promise<void>

function setup(script: (prompt: string, count: number, options: PromptOptions) => Promise<AcpReply> | AcpReply = () => said(), over: AcpSessionsOptions = {}, open?: (options: OpenOptions) => Promise<AcpAgentLike>) {
  const opened: FakeAgent[] = []
  const removed: string[] = []
  const created: string[] = []
  const pool = new AcpSessions({
    open: open ?? (async (options) => { const agent = new FakeAgent(options, script); opened.push(agent); return agent }),
    scratch: { create: () => { const folder = `scratch-${created.length + 1}`; created.push(folder); return folder }, remove: (folder) => { removed.push(folder) } },
    idleMs: 10_000,
    ...over
  })
  return { pool, opened, removed, created }
}

const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'gemini', name: 'Gemini', enabled: true, preset: 'gemini', command: 'gemini', args: ['--acp'], ...over })
const ask = (over: Partial<AcpAsk> = {}): AcpAsk => ({ conversationId: 'c1', history: [], message: 'Is the migration safe?', ...over })

describe('the first message', () => {
  it('starts a session in an empty folder, and sends the protocol with the message', async () => {
    const { pool, opened, created } = setup()
    const run = await pool.ask(peer(), ask())
    expect(run).toMatchObject({ ok: true, reply: 'Looks fine.\nVerdict: agree' })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.options.cwd).toBe(created[0])
    expect(opened[0]!.options.peer.id).toBe('gemini')
    expect(opened[0]!.prompts[0]).toContain('You are being consulted by another AI agent')
    expect(opened[0]!.prompts[0]).toContain("The agent's message:\n\nIs the migration safe?")
    expect(opened[0]!.prompts[0]).not.toContain('Earlier in this conversation')
  })

  it('starts in the project when the agent may read it and the task has one', async () => {
    const project = process.cwd()
    const { pool, opened, created } = setup()
    await pool.ask(peer({ readProject: true }), ask({ workspace: project }))
    expect(opened[0]!.options.cwd).toBe(project)
    expect(created).toHaveLength(0)
    expect(opened[0]!.prompts[0]).toContain('may read its files')
  })
})

describe('the messages after it', () => {
  it('go to the same session, without the protocol again', async () => {
    const { pool, opened } = setup()
    await pool.ask(peer(), ask({ message: 'First' }))
    await pool.ask(peer(), ask({ message: 'Second', history: [{ message: 'First', reply: 'Looks fine.' }] }))
    expect(opened).toHaveLength(1)
    expect(opened[0]!.prompts[1]).toBe("The agent's message:\n\nSecond\n\nAnswer as before, and end with the verdict line.")
    expect(opened[0]!.prompts[1]).not.toContain('You are being consulted')
  })

  it('wait their turn when there are several at once, and keep their order', async () => {
    let running = 0
    let most = 0
    const { pool, opened } = setup(async () => {
      running++
      most = Math.max(most, running)
      await delay(20)
      running--
      return said()
    })
    const runs = await Promise.all([1, 2, 3, 4].map((n) => pool.ask(peer(), ask({ message: `m${n}` }))))
    expect(runs.every((run) => run.ok)).toBe(true)
    expect(most).toBe(1)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.prompts.map((prompt) => /m\d/.exec(prompt)![0])).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('go to another session for another task or another agent', async () => {
    const { pool, opened } = setup()
    await pool.ask(peer(), ask())
    await pool.ask(peer(), ask({ conversationId: 'c2' }))
    await pool.ask(peer({ id: 'codex', name: 'Codex' }), ask())
    expect(opened).toHaveLength(3)
    expect(pool.live).toBe(3)
  })

  it('start a new session when the agent was edited, and stop the old one', async () => {
    const { pool, opened, removed, created } = setup()
    await pool.ask(peer(), ask())
    await pool.ask(peer({ args: ['--acp', '--other'] }), ask())
    expect(opened).toHaveLength(2)
    expect(opened[0]!.killed).toEqual([undefined])
    expect(removed).toEqual([created[0]])
    await pool.ask(peer({ args: ['--acp', '--other'], passEnv: ['GEMINI_API_KEY'] }), ask())
    await pool.ask(peer({ args: ['--acp', '--other'], passEnv: ['GEMINI_API_KEY'], authMethod: 'x' }), ask())
    expect(opened).toHaveLength(4)
  })
})

describe('when something goes wrong', () => {

  it('stops a session that failed, and starts the next message in a new one that carries the talk so far', async () => {
    let failing = true
    const { pool, opened, removed, created } = setup(() => {
      if (failing) { failing = false; throw new AcpFailure('Gemini stopped unexpectedly with exit code 1.', { hint: 'Sign in first.' }) }
      return said()
    })
    const failed = await pool.ask(peer(), ask())
    expect(failed).toMatchObject({ ok: false, error: 'Gemini stopped unexpectedly with exit code 1.', hint: 'Sign in first.' })
    expect(opened[0]!.killed).toHaveLength(1)
    expect(removed).toEqual([created[0]])
    const history = [{ message: 'Earlier question', reply: 'Earlier answer.' }]
    const again = await pool.ask(peer(), ask({ message: 'Next', history }))
    expect(again.ok).toBe(true)
    expect(opened).toHaveLength(2)
    expect(opened[1]!.prompts[0]).toContain('Earlier in this conversation')
    expect(opened[1]!.prompts[0]).toContain('Agent: Earlier question')
  })

  it('does not start a message for a turn that is cancelled', async () => {
    const { pool, opened } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await pool.ask(peer(), ask(), { signal: controller.signal })).toMatchObject({ ok: false, error: 'Cancelled.' })
    expect(opened).toHaveLength(0)
  })
})

describe('keeping and stopping sessions', () => {
  it('stops a session that nobody used for a while, politely, and starts the next one fresh', async () => {
    const { pool, opened, removed, created } = setup(undefined, { idleMs: 40 })
    await pool.ask(peer(), ask())
    await delay(10)
    expect(opened[0]!.closed).toBe(false)
    await eventually(() => expect(opened[0]!.closed).toBe(true))
    await eventually(() => expect(removed).toEqual([created[0]]))
    expect(pool.live).toBe(0)
    await pool.ask(peer(), ask({ history: [{ message: 'a', reply: 'b' }] }))
    expect(opened).toHaveLength(2)
    expect(opened[1]!.prompts[0]).toContain('Earlier in this conversation')
  })

  it('does not stop a session in the middle of an answer, however long it takes', async () => {
    const { pool, opened } = setup(async () => { await delay(120); return said() }, { idleMs: 40 })
    const run = await pool.ask(peer(), ask())
    expect(run.ok).toBe(true)
    expect(opened[0]!.closed).toBe(false)
    expect(opened[0]!.alive).toBe(true)
  })

  it('stops the sessions of a task that was deleted, and only those', async () => {
    const { pool, opened, removed, created } = setup()
    await pool.ask(peer(), ask({ conversationId: 'c1' }))
    await pool.ask(peer({ id: 'codex', name: 'Codex' }), ask({ conversationId: 'c1' }))
    await pool.ask(peer(), ask({ conversationId: 'c2' }))
    pool.forgetConversation('c1')
    expect(opened.map((agent) => agent.alive)).toEqual([false, false, true])
    expect(removed.sort()).toEqual([created[0], created[1]].sort())
    expect(pool.live).toBe(1)
  })

  it('stops everything at once when the app quits, and starts nothing afterwards', async () => {
    const { pool, opened, removed, created } = setup()
    await pool.ask(peer(), ask({ conversationId: 'c1' }))
    await pool.ask(peer(), ask({ conversationId: 'c2' }))
    pool.dispose()
    expect(opened.map((agent) => agent.killed)).toEqual([[true], [true]])
    expect(removed.sort()).toEqual([...created].sort())
    expect(pool.live).toBe(0)
    expect(await pool.ask(peer(), ask())).toMatchObject({ ok: false, error: 'Cubex is closing.' })
    expect(opened).toHaveLength(2)
  })
})

describe('trying an agent', () => {
  it('sends one message in a session of its own, then ends it', async () => {
    const { pool, opened, removed, created } = setup()
    const run = await pool.test(peer(), 'Reply with the single word OK.')
    expect(run).toMatchObject({ ok: true })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.options.cwd).toBe(created[0])
    expect(opened[0]!.prompts[0]).toContain('Reply with the single word OK.')
    expect(opened[0]!.closed).toBe(true)
    expect(removed).toEqual([created[0]])
    expect(pool.live).toBe(0)
  })
})
