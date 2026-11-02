import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpProcess } from '../acp/process'
import { AntigravityFilter, type FilterOptions } from './filter'
import { AUTH_BROWSER_MARKER, AUTH_STDOUT_PREFIX, SIGN_IN_FIRST, SIGN_IN_FIRST_HINT, SIGN_IN_PAGE_REFUSED, SIGN_IN_PAGE_REFUSED_HINT, type AuthorizationRequest } from './profile'

type Message = Record<string, unknown>

const ADDRESS = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43211%2F&response_type=code&state=xyz'

interface FakeRuntime {
  process: AcpProcess
  /** What the filter wrote to it, as the lines they are. */
  lines: string[]
  messages(): Message[]
  say(message: Message | string): void
  stderr(text: string): void
  exit(code: number | null): void
  stopped: boolean[]
  inputEnded(): boolean
}

function fakeRuntime(): FakeRuntime {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const lines: string[] = []
  const stopped: boolean[] = []
  let ended = false
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('end', () => { ended = true })
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      lines.push(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
  })
  return {
    process: {
      stdin,
      stdout,
      stderr,
      once: ((event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener)) as AcpProcess['once'],
      stop: (sync) => { stopped.push(sync) }
    },
    lines,
    messages: () => lines.map((line) => JSON.parse(line) as Message),
    say: (message) => { stdout.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`) },
    stderr: (text) => { stderr.write(text) },
    exit: (code) => { stdout.end(); setImmediate(() => emitter.emit('close', code)) },
    stopped,
    inputEnded: () => ended
  }
}

interface FakeClient {
  /** What the client was sent: a message, or a line that was not one. */
  received: Array<Message | string>
  errors: string[]
  send(message: Message): void
  closed: Array<number | null>
}

function client(filter: AntigravityFilter): FakeClient {
  const state: FakeClient = { received: [], errors: [], send: (message) => { filter.process.stdin!.write(`${JSON.stringify(message)}\n`) }, closed: [] }
  let buffer = ''
  filter.process.stdout!.setEncoding('utf8')
  filter.process.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try { state.received.push(JSON.parse(line) as Message) } catch { state.received.push(line) }
    }
  })
  filter.process.stderr!.setEncoding('utf8')
  filter.process.stderr!.on('data', (chunk: string) => { state.errors.push(chunk) })
  filter.process.once('close', (code) => state.closed.push(code))
  return state
}

const until = async (condition: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await new Promise((done) => setTimeout(done, 10))
  expect(condition()).toBe(true)
}
const settleAWhile = (ms = 40): Promise<void> => new Promise((done) => setTimeout(done, ms))

const running: AntigravityFilter[] = []
afterEach(() => { for (const filter of running.splice(0)) filter.stop(true) })

function make(options: Partial<FilterOptions> = {}): { runtime: FakeRuntime; filter: AntigravityFilter; client: FakeClient } {
  const runtime = fakeRuntime()
  const filter = new AntigravityFilter({ runtime: runtime.process, signedIn: () => true, closeGraceMs: 150, ...options })
  running.push(filter)
  return { runtime, filter, client: client(filter) }
}

describe('what passes through as it was sent', () => {
  it('is a request of the client, which the runtime receives unchanged, and the answer to it', async () => {
    const { runtime, client: c } = make()
    c.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] } })
    await until(() => runtime.lines.length === 1)
    expect(runtime.messages()[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] } })
    runtime.say({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })
  })

  it('is an update about anything but a tool call', async () => {
    const { runtime, client: c } = make()
    const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } }
    runtime.say(update)
    await until(() => c.received.length === 1)
    expect(c.received[0]).toEqual(update)
  })

  it('is a line that is not a message, which the client counts and ignores, and not a blank line', async () => {
    const { runtime, client: c } = make()
    runtime.say('Loading the model')
    runtime.say('')
    runtime.say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk' } } })
    await until(() => c.received.length === 2)
    expect(c.received[0]).toBe('Loading the model')
  })

  it('is what the runtime prints to its error output, apart from the sign-in report', async () => {
    const { runtime, client: c } = make()
    runtime.stderr('warning: slow disk\n')
    await until(() => c.errors.join('').includes('slow disk'))
    runtime.stderr(`${AUTH_STDOUT_PREFIX}${ADDRESS}\n`)
    await settleAWhile()
    expect(c.errors.join('')).not.toContain('accounts.google.com')
  })
})

describe('the handshake', () => {
  it('offers only the way to sign in that Cubex uses', async () => {
    const { runtime, client: c } = make()
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    await until(() => runtime.lines.length === 1)
    runtime.say({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }, { id: 'gemini-api-key', name: 'Key' }] } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] } })
  })

  it('tells a chat that has no sign-in saved to sign in, in words, and not "authentication required"', async () => {
    const { runtime, client: c } = make({ signedIn: () => false })
    c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/p', mcpServers: [] } })
    await until(() => runtime.lines.length === 1)
    runtime.say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: SIGN_IN_FIRST, data: { hint: SIGN_IN_FIRST_HINT } } })
  })

  it('leaves the runtime\'s own answer when a sign-in is saved, because it still has to authenticate', async () => {
    const { runtime, client: c } = make({ signedIn: () => true })
    c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toMatchObject({ error: { code: -32000 } })
  })

  it('leaves it too when the person is signing in, which is what the runtime is for then', async () => {
    const { runtime, client: c } = make({ signedIn: () => false, onAuthorizationUrl: () => undefined })
    c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toMatchObject({ error: { code: -32000 } })
  })

  it('names itself in the message', async () => {
    const { runtime, client: c } = make({ signedIn: () => false, name: 'Gemini' })
    c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'x' } })
    await until(() => c.received.length === 1)
    expect(c.received[0]).toMatchObject({ error: { message: 'Gemini is not signed in.' } })
  })
})

describe('the runtime\'s tool calls', () => {
  it('have their command under the name Cubex reads, in updates and in permission requests', async () => {
    const { runtime, client: c } = make()
    runtime.say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run command', rawInput: { CommandLine: 'npm test' } } } })
    runtime.say({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'c1', rawInput: { CommandLine: 'npm test' } }, options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }] } })
    await until(() => c.received.length === 2)
    expect(c.received[0]).toMatchObject({ params: { update: { kind: 'execute', rawInput: { command: 'npm test' } } } })
    expect(c.received[1]).toMatchObject({ id: 9, method: 'session/request_permission', params: { toolCall: { kind: 'execute', rawInput: { command: 'npm test' } }, options: [{ optionId: 'a' }] } })
  })
})

describe('a question for the person', () => {
  it('is answered "cancelled" for them, and never reaches the client', async () => {
    const { runtime, client: c } = make()
    runtime.say({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'interaction_3', title: 'Which one?' }, options: [{ optionId: 'a', kind: 'allow_once', name: 'A' }, { optionId: 'b', kind: 'allow_once', name: 'B' }] } })
    await until(() => runtime.lines.length === 1)
    expect(runtime.messages()[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } })
    await settleAWhile()
    expect(c.received).toEqual([])
  })
})

describe('the runtime asking for a sign-in in a chat', () => {
  it('fails what the chat is waiting for, with the reason, and stops the runtime', async () => {
    const { runtime, client: c } = make()
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: { methodId: 'oauth-personal' } })
    c.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: {} })
    await until(() => runtime.lines.length === 2)
    runtime.say(`${AUTH_STDOUT_PREFIX}${ADDRESS}`)
    await until(() => c.received.length === 2 && c.closed.length === 1)
    expect(c.received).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: -32603, message: SIGN_IN_FIRST, data: { hint: SIGN_IN_FIRST_HINT } } },
      { jsonrpc: '2.0', id: 4, error: { code: -32603, message: SIGN_IN_FIRST, data: { hint: SIGN_IN_FIRST_HINT } } }
    ])
    expect(runtime.stopped).toEqual([false])
    expect(c.errors.join('')).toContain(SIGN_IN_FIRST)
  })

  it('does the same when the stand-in browser is what reports it', async () => {
    const { runtime, client: c } = make()
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.stderr(`${AUTH_BROWSER_MARKER}${JSON.stringify(ADDRESS)}\n`)
    await until(() => c.received.length === 1)
    expect(c.received[0]).toMatchObject({ id: 3, error: { message: SIGN_IN_FIRST } })
    expect(runtime.stopped).toEqual([false])
  })

  it('stops the runtime even when nothing is waiting', async () => {
    const { runtime, client: c } = make()
    runtime.say(`${AUTH_STDOUT_PREFIX}${ADDRESS}`)
    await until(() => runtime.stopped.length === 1)
    await until(() => c.closed.length === 1)
    expect(c.received).toEqual([])
  })

  it('does not forward the address, which is not for the client', async () => {
    const { runtime, client: c } = make()
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say(`${AUTH_STDOUT_PREFIX}${ADDRESS}`)
    await until(() => c.closed.length === 1)
    expect(JSON.stringify(c.received)).not.toContain('accounts.google.com')
  })
})

describe('signing in', () => {
  it('hands the address to whoever asked, once however many times it is printed, and goes on waiting', async () => {
    const found: AuthorizationRequest[] = []
    const { runtime, client: c } = make({ onAuthorizationUrl: (request) => found.push(request) })
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say(`${AUTH_STDOUT_PREFIX}${ADDRESS}`)
    runtime.stderr(`${AUTH_BROWSER_MARKER}${JSON.stringify(ADDRESS)}\n`)
    await until(() => found.length >= 1)
    await settleAWhile()
    expect(found).toHaveLength(1)
    expect(found[0]).toEqual({ authorizationUrl: ADDRESS, redirectUri: 'http://127.0.0.1:43211/', state: 'xyz' })
    expect(runtime.stopped).toEqual([])
    expect(c.received).toEqual([])
    runtime.say({ jsonrpc: '2.0', id: 3, result: {} })
    await until(() => c.received.length === 1)
  })

  it('does not hand over an address that is not Google\'s, and fails the sign-in at once instead of waiting for a page that will not be opened', async () => {
    const found: AuthorizationRequest[] = []
    const { runtime, client: c } = make({ onAuthorizationUrl: (request) => found.push(request) })
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say(`${AUTH_STDOUT_PREFIX}https://evil.example/o/oauth2/v2/auth?state=x&redirect_uri=http://127.0.0.1:43211/&response_type=code`)
    await until(() => c.received.length === 1 && c.closed.length === 1)
    expect(found).toEqual([])
    expect(c.received[0]).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: SIGN_IN_PAGE_REFUSED, data: { hint: SIGN_IN_PAGE_REFUSED_HINT } } })
    expect(runtime.stopped).toEqual([false])
    expect(c.errors.join('')).toContain(SIGN_IN_PAGE_REFUSED)
  })

  it('does the same for an address the stand-in browser reports', async () => {
    const found: AuthorizationRequest[] = []
    const { runtime, client: c } = make({ onAuthorizationUrl: (request) => found.push(request) })
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.stderr(`${AUTH_BROWSER_MARKER}"https://evil.example/"\n`)
    await until(() => c.received.length === 1)
    expect(found).toEqual([])
    expect(c.received[0]).toMatchObject({ id: 3, error: { message: SIGN_IN_PAGE_REFUSED } })
    expect(runtime.stopped).toEqual([false])
  })

  it('goes on waiting when a page of Google\'s was already reported and a line that is not one comes after it', async () => {
    const found: AuthorizationRequest[] = []
    const { runtime, client: c } = make({ onAuthorizationUrl: (request) => found.push(request) })
    c.send({ jsonrpc: '2.0', id: 3, method: 'authenticate', params: {} })
    await until(() => runtime.lines.length === 1)
    runtime.say(`${AUTH_STDOUT_PREFIX}${ADDRESS}`)
    await until(() => found.length === 1)
    runtime.say(`${AUTH_STDOUT_PREFIX}not an address`)
    await settleAWhile()
    // The page is open and the person may be signing in on it: a stray line is not opened, and is not a reason to end that.
    expect(found).toHaveLength(1)
    expect(runtime.stopped).toEqual([])
    expect(c.received).toEqual([])
  })
})

describe('ending', () => {
  it('tells the client the runtime ended, with how, and runs the cleanup once', async () => {
    let cleaned = 0
    const { runtime, client: c } = make({ cleanup: () => { cleaned++ } })
    runtime.exit(3)
    await until(() => c.closed.length === 1)
    expect(c.closed).toEqual([3])
    expect(cleaned).toBe(1)
  })

  it('ends the runtime\'s input when the client ends its own, and stops the runtime if it stays', async () => {
    const { runtime, filter } = make()
    filter.process.stdin!.end()
    await until(() => runtime.inputEnded())
    await until(() => runtime.stopped.length === 1)
  })

  it('stops the runtime at once when it is stopped, and says so', async () => {
    const { runtime, filter, client: c } = make()
    filter.process.stop(true)
    expect(runtime.stopped).toEqual([true])
    await until(() => c.closed.length === 1)
  })

  it('keeps the end of the runtime until someone listens for it', async () => {
    const runtime = fakeRuntime()
    const filter = new AntigravityFilter({ runtime: runtime.process, signedIn: () => true })
    running.push(filter)
    runtime.exit(0)
    await settleAWhile(400)
    const heard: Array<number | null> = []
    filter.process.once('close', (code) => heard.push(code))
    await until(() => heard.length === 1)
    expect(heard).toEqual([0])
  })

  describe('what the run held', () => {
    it('is kept while a runtime that was told to stop is still going, and given up when it is gone', async () => {
      let cleaned = 0
      const { runtime, filter, client: c } = make({ cleanup: () => { cleaned++ } })
      filter.process.stop(false)
      // The client is told at once. The runtime is dying, and a program that is still going holds its folder and its release.
      await until(() => c.closed.length === 1)
      await settleAWhile(100)
      expect(cleaned).toBe(0)
      runtime.exit(1)
      await until(() => cleaned === 1)
      await settleAWhile(100)
      expect(cleaned).toBe(1)
    })

    it('is given up anyway when a runtime that was stopped does not say it is gone', async () => {
      let cleaned = 0
      const { filter } = make({ exitWaitMs: 120, cleanup: () => { cleaned++ } })
      filter.process.stop(false)
      await settleAWhile(60)
      expect(cleaned).toBe(0)
      await until(() => cleaned === 1)
    })

    it('is given up at once when the stop waited for the runtime to be gone', async () => {
      let cleaned = 0
      const { filter } = make({ cleanup: () => { cleaned++ } })
      filter.process.stop(true)
      expect(cleaned).toBe(1)
    })

    it('is given up once, however many ways say the runtime is over', async () => {
      let cleaned = 0
      const { runtime, filter } = make({ exitWaitMs: 50, cleanup: () => { cleaned++ } })
      filter.process.stop(false)
      runtime.exit(0)
      await settleAWhile(200)
      expect(cleaned).toBe(1)
    })
  })
})
