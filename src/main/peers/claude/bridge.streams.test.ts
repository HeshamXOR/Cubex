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

  it('starts with the control request that makes Claude Code say who it is signed in as', async () => {
    const claude = fakeClaude()
    running.push(new ClaudeBridge({ claude: claude.process, cwd: process.cwd() }))
    await until(() => claude.sent.length > 0)
    expect(claude.sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', hooks: null } })
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

  it('waits for Claude Code to answer, and gives up when it does not', async () => {
    const claude = fakeClaude(null)
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd(), startTimeoutMs: 100 })
    running.push(bridge)
    const error = await settled(client(bridge).connection.request('initialize', { protocolVersion: 1 })) as AcpRequestError
    expect(error.message).toBe('Claude Code did not get ready within 1 second.')
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

  it('keeps a failure to start until someone listens for it, so a program that fails at once is not lost', async () => {
    const claude = fakeClaude(null)
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd() })
    running.push(bridge)
    const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException
    claude.fail(error)
    await new Promise((done) => setTimeout(done, 20))
    const heard: unknown[] = []
    bridge.process.once('error', (caught) => heard.push(caught))
    await until(() => heard.length > 0)
    expect(heard[0]).toBe(error)
  })

  it('keeps the end of the program the same way', async () => {
    const claude = fakeClaude()
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd() })
    running.push(bridge)
    claude.exit(0)
    await new Promise((done) => setTimeout(done, 400))
    const heard: Array<number | null> = []
    bridge.process.once('close', (code) => heard.push(code))
    await until(() => heard.length > 0)
    expect(heard).toEqual([0])
  })

  it('has one session, and says so when asked for a second', async () => {
    const s = await session()
    const error = await settled(s.client.connection.request('session/new', { cwd: '.', mcpServers: [] })) as AcpRequestError
    expect(error.message).toBe('This agent has one session, and it is open.')
  })

  it('has one mode, and answers a request for it and for no other', async () => {
    const s = await session()
    await expect(s.client.connection.request('session/set_mode', { sessionId: s.sessionId, modeId: 'default' })).resolves.toEqual({})
    const error = await settled(s.client.connection.request('session/set_mode', { sessionId: s.sessionId, modeId: 'bypassPermissions' })) as AcpRequestError
    expect(error.code).toBe(RPC_ERROR.invalidParams)
  })

  it('says a method it does not have is not there, signing in included, because Claude Code signs in by itself', async () => {
    const s = await session()
    for (const method of ['authenticate', 'session/load', 'fs/read_text_file']) {
      const error = await settled(s.client.connection.request(method, {})) as AcpRequestError
      expect(error.code).toBe(RPC_ERROR.methodNotFound)
    }
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

  it('must name the session, have text in it, and be the only one at a time', async () => {
    const s = await session()
    expect((await settled(s.client.connection.request('session/prompt', { sessionId: 'other', prompt: [{ type: 'text', text: 'x' }] })) as AcpRequestError).message).toBe('There is no such session.')
    expect((await settled(s.client.connection.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'image' }] })) as AcpRequestError).message).toBe('The message has no text.')
    const first = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    expect((await settled(prompt(s)) as AcpRequestError).message).toBe('Claude Code is still answering another message.')
    s.claude.say(result())
    await first
  })

  it('joins the text parts of a message and leaves the rest', async () => {
    const s = await session()
    const pending = s.client.connection.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'one' }, { type: 'resource_link', uri: 'file:///x' }, { type: 'text', text: 'two' }] })
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    expect(s.claude.sent.find((message) => message.type === 'user')).toMatchObject({ message: { content: [{ text: 'one\n\ntwo' }] } })
    s.claude.say(result())
    await pending
  })

  it('keeps thinking, a subagent\'s words and lines that are not messages out of the reply', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.raw('Warning: something on the wrong stream\n\n{broken\n')
    s.claude.say({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] }, parent_tool_use_id: null })
    s.claude.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'from a subagent' }] }, parent_tool_use_id: 'toolu_x' })
    s.claude.say({ type: 'system', subtype: 'init' })
    s.claude.say({ type: 'stream_event', event: {} })
    s.claude.say(result())
    await pending
    expect(updates(s, 'agent_message_chunk').map((update) => (update.content as Message).text)).toEqual(['answer'])
    expect(s.bridge.ignored).toBe(2)
  })

  it('tells of a tool call as it starts and as it ends', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.say(toolUse('toolu_1', 'Read', { file_path: 'src/a.ts', offset: 3 }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }, parent_tool_use_id: null })
    s.claude.say(toolUse('toolu_2', 'Bash', { command: 'false' }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'no', is_error: true }] }, parent_tool_use_id: null })
    s.claude.say(result())
    await pending
    expect(updates(s, 'tool_call')).toMatchObject([
      { toolCallId: 'toolu_1', title: 'Read src/a.ts', kind: 'read', status: 'pending', locations: [{ line: 3 }] },
      { toolCallId: 'toolu_2', title: 'Run false', kind: 'execute', status: 'pending', rawInput: { command: 'false' } }
    ])
    expect(updates(s, 'tool_call_update')).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'completed' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_2', status: 'failed' }
    ])
  })

  it('says what went wrong when the result says it was an error, and what it stopped for when it was not', async () => {
    const s = await session()
    let pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.say(result({ is_error: true, subtype: 'error_during_execution', result: undefined, errors: ['Tool exploded', 7, 'twice'] }))
    expect((await settled(pending) as AcpRequestError).message).toBe('Claude Code stopped with an error: Tool exploded\ntwice')
    pending = prompt(s)
    await until(() => s.claude.sent.filter((message) => message.type === 'user').length === 2)
    s.claude.say(result({ is_error: true, subtype: 'error_max_budget_usd', result: undefined }))
    expect((await settled(pending) as AcpRequestError).message).toBe('Claude Code stopped with an error (error_max_budget_usd).')
    pending = prompt(s)
    await until(() => s.claude.sent.filter((message) => message.type === 'user').length === 3)
    s.claude.say(result({ subtype: 'error_max_turns', is_error: false }))
    expect(await pending).toEqual({ stopReason: 'max_turn_requests' })
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

  it('is answered by its own request, when two are put at once and answered the other way round', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    const release: Array<(answer: unknown) => void> = []
    s.client.answer = () => new Promise((resolve) => { release.push(resolve) })
    s.claude.say(canUse('qa', 'toolu_a', 'Read', { file_path: 'a.ts' }))
    s.claude.say(canUse('qb', 'toolu_b', 'Read', { file_path: 'b.ts' }))
    await until(() => release.length === 2)
    release[1]!({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await until(() => responsesTo(s.claude).length === 1)
    expect(responsesTo(s.claude)[0]).toMatchObject({ request_id: 'qb', response: { behavior: 'allow' } })
    release[0]!({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
    await until(() => responsesTo(s.claude).length === 2)
    expect(responsesTo(s.claude)[1]).toMatchObject({ request_id: 'qa', response: { behavior: 'deny' } })
    s.claude.say(result())
    await pending
  })

  it('is dropped when Claude Code withdraws it, and a late answer is not sent', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    let release: (answer: unknown) => void = () => undefined
    s.client.answer = () => new Promise((resolve) => { release = resolve })
    s.claude.say(canUse('qw', 'toolu_w', 'Bash', { command: 'ls' }))
    await until(() => s.client.questions.length === 1)
    s.claude.say({ type: 'control_cancel_request', request_id: 'qw' })
    await new Promise((done) => setTimeout(done, 30))
    release({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await new Promise((done) => setTimeout(done, 50))
    expect(responsesTo(s.claude)).toEqual([])
    s.claude.say(result())
    await pending
  })

  it('has no message waiting for it when none was sent, and is denied', async () => {
    const s = await session()
    s.claude.say(canUse('qs', 'toolu_s', 'Bash', { command: 'ls' }))
    await until(() => responsesTo(s.claude).length === 1)
    expect(responsesTo(s.claude)[0]).toMatchObject({ request_id: 'qs', response: { behavior: 'deny', message: 'There is no message waiting for this.' } })
    expect(s.client.questions).toEqual([])
  })

  it('is asked about once for the call, whichever comes first, the call or the question', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.say(canUse('q1', 'toolu_1', 'Write', { file_path: 'a.txt', content: 'x' }))
    await until(() => responsesTo(s.claude).length === 1)
    s.claude.say(toolUse('toolu_1', 'Write', { file_path: 'a.txt', content: 'x' }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, parent_tool_use_id: null })
    s.claude.say(result())
    expect(await pending).toEqual({ stopReason: 'end_turn' })
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

  it('does not count a tool that failed, or one that only reads', async () => {
    const s = await session()
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.claude.say(toolUse('toolu_1', 'Write', { file_path: 'x.txt', content: 'x' }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'No such tool available: Write', is_error: true }] }, parent_tool_use_id: null })
    s.claude.say(toolUse('toolu_2', 'Grep', { pattern: 'x' }))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'found' }] }, parent_tool_use_id: null })
    s.claude.say(toolUse('toolu_3', 'Mystery', {}))
    s.claude.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'fine' }] }, parent_tool_use_id: null })
    s.claude.say(result())
    expect(await pending).toEqual({ stopReason: 'end_turn' })
    expect(s.claude.stopped).toEqual([])
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

  it('does nothing when there is no message to cancel', async () => {
    const s = await session()
    s.client.connection.notify('session/cancel', { sessionId: s.sessionId })
    await new Promise((done) => setTimeout(done, 40))
    expect(s.claude.sent.some((message) => (message.request as Message | undefined)?.subtype === 'interrupt')).toBe(false)
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

describe('ending', () => {
  it('ends Claude Code\'s input when the client ends its own, which is how a session is closed', async () => {
    const s = await session()
    s.bridge.process.stdin!.end()
    await until(() => s.claude.inputEnded())
  })

  it('stops Claude Code if it stays after its input ended', async () => {
    const s = await session()
    s.bridge.process.stdin!.end()
    await until(() => s.claude.stopped.length === 1)
    expect(s.claude.stopped).toEqual([false])
  })

  it('fails the message that is being answered when it is stopped, and says the program ended', async () => {
    const s = await session()
    const closed: Array<number | null> = []
    s.bridge.process.once('close', (code) => closed.push(code))
    const pending = prompt(s)
    await until(() => s.claude.sent.some((message) => message.type === 'user'))
    s.bridge.process.stop(false)
    expect((await settled(pending) as AcpRequestError).message).toBe('Claude Code stopped unexpectedly.')
    await until(() => closed.length === 1)
    expect(s.claude.stopped).toEqual([false])
  })

  it('passes on what Claude Code prints to its error output', async () => {
    const s = await session()
    let seen = ''
    s.bridge.process.stderr!.setEncoding('utf8')
    s.bridge.process.stderr!.on('data', (chunk: string) => { seen += chunk })
    s.claude.stderr('something went wrong\n')
    await until(() => seen.includes('something went wrong'))
  })

  it('runs its cleanup once when it is over', async () => {
    let cleaned = 0
    const claude = fakeClaude()
    const bridge = new ClaudeBridge({ claude: claude.process, cwd: process.cwd(), cleanup: () => { cleaned++ } })
    claude.exit(0)
    await until(() => cleaned === 1)
    bridge.stop(true)
    await new Promise((done) => setTimeout(done, 30))
    expect(cleaned).toBe(1)
  })
})
