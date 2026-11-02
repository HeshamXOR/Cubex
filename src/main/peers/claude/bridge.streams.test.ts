import { EventEmitter } from 'node:events'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpConnection, AcpRequestError, RPC_ERROR } from '../acp/connection'
import type { AcpProcess } from '../acp/process'
import { ClaudeBridge, SIGN_IN_HINT } from './bridge'

/**
 * The bridge against a Claude Code that is a pair of streams the test writes to and reads from, and a client that is the
 * protocol's other end. For what a real program makes hard to do on purpose: two questions at once, a question withdrawn,
 * a program that ends at a particular moment.
 */

type Message = Record<string, unknown>

interface FakeClaude {
  process: AcpProcess
  /** What the bridge sent to it, parsed. */
  sent: Message[]
  say(message: Message): void
  raw(text: string): void
  stderr(text: string): void
  exit(code: number | null): void
  fail(error: NodeJS.ErrnoException): void
  stopped: boolean[]
  inputEnded(): boolean
  /** Answers the control request that starts it, with the account it reports; null does not answer it. */
  account: Message | null
}

function fakeClaude(account: Message | null = { tokenSource: 'claude.ai', apiProvider: 'firstParty' }): FakeClaude {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const sent: Message[] = []
  const stopped: boolean[] = []
  let ended = false
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('end', () => { ended = true })
  const fake: FakeClaude = {
    process: {
      stdin,
      stdout,
      stderr,
      once: ((event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener)) as AcpProcess['once'],
      stop: (sync) => { stopped.push(sync) }
    },
    sent,
    say: (message) => { stdout.write(`${JSON.stringify(message)}\n`) },
    raw: (text) => { stdout.write(text) },
    stderr: (text) => { stderr.write(text) },
    exit: (code) => { stdout.end(); setImmediate(() => emitter.emit('close', code)) },
    fail: (error) => { emitter.emit('error', error) },
    stopped,
    inputEnded: () => ended,
    account
  }
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const message = JSON.parse(line) as Message
      sent.push(message)
      const request = message.request as Message | undefined
      if (message.type === 'control_request' && request?.subtype === 'initialize' && fake.account !== null) {
        fake.say({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], account: fake.account } } })
      }
    }
  })
  return fake
}

interface Client {
  connection: AcpConnection
  notifications: Array<{ method: string; params: Message }>
  /** The permission requests the client was sent. */
  questions: Message[]
  /** How the client answers one; replace it to hold an answer back. */
  answer: (params: Message) => Promise<unknown>
}

function client(bridge: ClaudeBridge): Client {
  const state: Client = {
    connection: undefined as unknown as AcpConnection,
    notifications: [],
    questions: [],
    answer: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  }
  state.connection = new AcpConnection(bridge.process.stdout as Readable, bridge.process.stdin as Writable, {
    onNotification: (method, params) => { state.notifications.push({ method, params: params as Message }) },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new AcpRequestError(RPC_ERROR.methodNotFound, method)
      state.questions.push(params as Message)
      return state.answer(params as Message)
    }
  })
  return state
}

const until = async (condition: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await new Promise((done) => setTimeout(done, 10))
  expect(condition()).toBe(true)
}
const settled = (work: Promise<unknown>): Promise<unknown> => work.then((value) => value, (error: unknown) => error)

const running: ClaudeBridge[] = []
afterEach(() => { for (const bridge of running.splice(0)) bridge.stop(true) })

interface Session { claude: FakeClaude; bridge: ClaudeBridge; client: Client; sessionId: string }

async function session(): Promise<Session> {
  const claude = fakeClaude()
  const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd(), startTimeoutMs: 5_000, closeGraceMs: 200 })
  running.push(bridge)
  const connection = client(bridge)
  await connection.connection.request('initialize', { protocolVersion: 1 })
  const created = await connection.connection.request('session/new', { cwd: process.cwd(), mcpServers: [] }) as { sessionId: string }
  return { claude, bridge, client: connection, sessionId: created.sessionId }
}

const prompt = (s: Session, text = 'go'): Promise<unknown> => s.client.connection.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text }] })
const toolUse = (id: string, name: string, input: Message): Message => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null })
const canUse = (requestId: string, toolUseId: string, name: string, input: Message): Message => ({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: toolUseId } })
const result = (extra: Message = {}): Message => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...extra })
const responsesTo = (claude: FakeClaude): Message[] => claude.sent.filter((message) => message.type === 'control_response').map((message) => message.response as Message)
const updates = (s: Session, kind: string): Message[] => s.client.notifications.filter((entry) => entry.method === 'session/update' && (entry.params.update as Message).sessionUpdate === kind).map((entry) => entry.params.update as Message)

describe('the handshake', () => {
  it('shakes hands with the protocol\'s own version, offers no way to sign in, and one mode', async () => {
    const claude = fakeClaude()
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd(), startTimeoutMs: 5_000 })
    running.push(bridge)
    const connection = client(bridge)
    expect(await connection.connection.request('initialize', { protocolVersion: 1 })).toMatchObject({ protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: false } })
    const created = await connection.connection.request('session/new', { cwd: '.', mcpServers: [] }) as { sessionId: string; modes: { currentModeId: string; availableModes: Array<{ id: string }> } }
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.modes).toMatchObject({ currentModeId: 'default', availableModes: [{ id: 'default' }] })
  })

  it('refuses when Claude Code has no login, with the way to sign in', async () => {
    const claude = fakeClaude({ tokenSource: 'none', apiProvider: 'firstParty' })
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd() })
    running.push(bridge)
    const error = await settled(client(bridge).connection.request('initialize', { protocolVersion: 1 })) as AcpRequestError
    expect(error).toBeInstanceOf(AcpRequestError)
    expect(error.message).toBe('Claude Code is not signed in.')
    expect(error.data).toEqual({ hint: SIGN_IN_HINT })
  })

  it('reports a Claude Code that ends before it answers, with what it printed to say why', async () => {
    const claude = fakeClaude(null)
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd() })
    running.push(bridge)
    const connection = client(bridge)
    const pending = settled(connection.connection.request('initialize', { protocolVersion: 1 }))
    claude.stderr('Error: Invalid API key · Please run /login\n')
    await new Promise((done) => setTimeout(done, 20))
    claude.exit(1)
    const error = await pending as AcpRequestError
    expect(error.message).toBe('Claude Code stopped unexpectedly with exit code 1.')
    expect((error.data as { hint: string }).hint).toContain('Sign in')
  })
})

describe('a message', () => {
  it('goes to Claude Code as the user\'s, and what it answers comes back', async () => {
    const s = await session()
    const pending = prompt(s, 'hello there')
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    expect(s.claude.sent.find((message) => message.type === 'user')).toMatchObject({ message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } })
    s.claude.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] }, parent_tool_use_id: null })
    s.claude.say(result({ stop_reason: 'end_turn' }))
    expect(await pending).toEqual({ stopReason: 'end_turn' })
    expect(updates(s, 'agent_message_chunk')).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi.' } }])
  })
})

describe('a question about a tool', () => {
  it('is put to the client as a permission request with what the tool will do, and only "this once" to choose', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    const input = { file_path: 'notes.txt', content: 'hello\n' }
    s.claude.say(toolUse('toolu_1', 'Write', input))
    s.claude.say(canUse('q1', 'toolu_1', 'Write', input))
    await until(() => s.client.questions.length === 1)
    expect(s.client.questions[0]).toMatchObject({
      sessionId: s.sessionId,
      toolCall: { toolCallId: 'toolu_1', title: 'Write notes.txt', kind: 'edit', status: 'pending', content: [{ type: 'diff', oldText: null, newText: 'hello\n' }] },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }]
    })
    expect(((s.client.questions[0]!.options) as Message[]).map((option) => option.kind)).not.toContain('allow_always')
    await until(() => responsesTo(s.claude).length === 1)
    expect(responsesTo(s.claude)[0]).toEqual({ subtype: 'success', request_id: 'q1', response: { behavior: 'allow', updatedInput: input } })
    s.claude.say(result())
    await pending
  })

  it('is denied for any answer but this once: a refusal, a cancel, an option that was not offered, nonsense or a failure', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    const answers: Array<() => Promise<unknown>> = [
      async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }),
      async () => ({ outcome: { outcome: 'cancelled' } }),
      async () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } }),
      async () => 'allow',
      async () => { throw new Error('the policy broke') }
    ]
    for (const [index, answer] of answers.entries()) {
      s.client.answer = answer
      s.claude.say(canUse(`q${index}`, `toolu_${index}`, 'Bash', { command: 'rm -rf x' }))
      await until(() => responsesTo(s.claude).length === index + 1)
    }
    expect(responsesTo(s.claude).map((response) => (response.response as Message).behavior)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny'])
    s.claude.say(result())
    await pending
  })
})

describe('a tool that ran without being asked', () => {
  it('ends the turn with why, and stops Claude Code, when it changes something', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.say(toolUse('toolu_1', 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'edited' }] }, parent_tool_use_id: null })
    const error = await settled(pending) as AcpRequestError
    expect(error.message).toBe('Claude Code did this without asking: Edit src/a.ts. Cubex cannot hold it to your permission mode, so it was stopped.')
    expect(s.claude.stopped).toEqual([false])
  })
})

describe('cancelling', () => {
  it('interrupts Claude Code, denies what it is waiting on at once, ignores the answers that come late, and ends as cancelled', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    let release: (answer: unknown) => void = () => undefined
    s.client.answer = () => new Promise((resolve) => { release = resolve })
    s.claude.say(canUse('qc', 'toolu_c', 'Bash', { command: 'sleep 99' }))
    await until(() => s.client.questions.length === 1)
    s.client.connection.notify('session/cancel', { sessionId: s.sessionId })
    await until(() => s.claude.sent.some((message) => (message.request as Message | undefined)?.subtype === 'interrupt'))
    await until(() => responsesTo(s.claude).length === 1)
    expect(responsesTo(s.claude)[0]).toMatchObject({ request_id: 'qc', response: { behavior: 'deny' } })
    release({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await new Promise((done) => setTimeout(done, 40))
    expect(responsesTo(s.claude)).toHaveLength(1)
    s.claude.say(result({ subtype: 'error_during_execution', is_error: true, result: '[Request interrupted by user]' }))
    expect(await pending).toEqual({ stopReason: 'cancelled' })
  })
})

describe('a request Cubex does not serve', () => {
  it('is refused, whatever it is called, so Claude Code is not left waiting', async () => {
    const s = await session()
    s.claude.say({ type: 'control_request', request_id: 'h1', request: { subtype: 'mcp_message', server_name: 'x' } })
    s.claude.say({ type: 'control_request', request_id: 'h2', request: { subtype: 'weird\nname' } })
    s.claude.say({ type: 'control_request', request: { subtype: 'can_use_tool' } })
    await until(() => responsesTo(s.claude).length === 2)
    expect(responsesTo(s.claude)).toEqual([
      { subtype: 'error', request_id: 'h1', error: 'Cubex does not handle "mcp_message" requests.' },
      { subtype: 'error', request_id: 'h2', error: 'Cubex does not handle "weird?name" requests.' }
    ])
  })
})
