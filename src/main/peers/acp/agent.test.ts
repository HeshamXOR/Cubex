import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPeer } from '@shared/peers'
import { removeFolder } from '../../testing/removeFolder'
import { AcpAgent, AcpFailure, REPLY_COLLECT_CAP, type OpenOptions } from './agent'

// A real program, started the way an agent is: a scripted agent that speaks the protocol (testing/mockAgent.cjs).
const MOCK = fileURLToPath(new URL('./testing/mockAgent.cjs', import.meta.url))
let dir: string
let recordPath: string
let counter = 0
const agents: AcpAgent[] = []

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-acp-agent-')))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export {}')
})
afterAll(() => removeFolder(dir))
beforeEach(() => { recordPath = join(dir, `record-${++counter}.jsonl`) })
afterEach(() => { for (const agent of agents.splice(0)) agent.kill(true) })

const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'mock', name: 'Mock', enabled: true, preset: 'custom', command: process.execPath, args: [MOCK], ...over })

async function open(env: Record<string, string> = {}, options: Partial<OpenOptions> = {}, over: Partial<AcpPeer> = {}): Promise<AcpAgent> {
  const agent = await AcpAgent.open({ peer: peer(over), cwd: dir, env: { ...process.env, MOCK_RECORD: recordPath, ...env }, ...options })
  agents.push(agent)
  return agent
}

interface Message { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
const recorded = (): Message[] => {
  try { return readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Message) } catch { return [] }
}
const methods = (): string[] => recorded().map((message) => message.method ?? 'reply')
const failure = async (work: Promise<unknown>): Promise<AcpFailure> => {
  const error = await work.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AcpFailure)
  return error as AcpFailure
}
const MODES = (current: string, available: Array<[string, string]>): string => JSON.stringify({ current, available: available.map(([id, name]) => ({ id, name })) })

describe('starting an agent', () => {
  it('shakes hands with the version Cubex speaks, and offers the agent nothing of this computer', async () => {
    await open()
    const [initialize, created] = recorded()
    expect(initialize).toMatchObject({ method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'cubex' } } })
    expect(created).toMatchObject({ method: 'session/new', params: { cwd: dir, mcpServers: [] } })
    expect(methods()).toEqual(['initialize', 'session/new'])
  })

  it('starts it in the folder it is given, with Cubex\'s own keys left out unless they are passed', async () => {
    const env = { OPENAI_API_KEY: 'sk-test', PLAIN: 'yes' }
    const without = await open(env)
    expect(realpathSync.native((await without.prompt('@mock cwd')).text)).toBe(dir)
    const reply = await without.prompt('@mock env OPENAI_API_KEY\n@mock env PLAIN')
    expect(reply.text).toBe('OPENAI_API_KEY=unsetPLAIN=yes')
    const withKey = await open(env, {}, { passEnv: ['OPENAI_API_KEY'] })
    expect((await withKey.prompt('@mock env OPENAI_API_KEY')).text).toBe('OPENAI_API_KEY=sk-test')
  })

  it('reads the agent\'s output through lines that are not messages', async () => {
    const agent = await open({ MOCK_NOISE: '1' })
    expect((await agent.prompt('@mock say fine')).text).toBe('fine')
  })

  it('says why a program that is not installed cannot start', async () => {
    const error = await failure(open({}, {}, { command: 'cubex-no-such-agent-xyz' }))
    expect(error.message).toContain('was not found')
  })

  it('reports a program that ends before it is ready, with what it printed and what to do', async () => {
    const error = await failure(open({ MOCK_EXIT_AT_START: '3', MOCK_STDERR: 'Error: Invalid API key. Please run /login\n' }))
    expect(error.message).toBe('Mock stopped unexpectedly with exit code 3.')
    expect(error.hint).toContain('Sign in')
    expect(error.output).toContain('Invalid API key')
  })

  it('stops a program that never answers the handshake', async () => {
    const error = await failure(open({ MOCK_HANG_START: '1' }, { startTimeoutMs: 400 }))
    expect(error.message).toBe('Mock did not get ready within 1 second and was stopped.')
    expect(error.hint).toContain('Agent Client Protocol')
  })

  it('stops starting when the turn is cancelled', async () => {
    const controller = new AbortController()
    const starting = open({ MOCK_HANG_START: '1' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    expect((await failure(starting)).message).toBe('Cancelled.')
    expect((await failure(open({}, { signal: controller.signal }))).message).toBe('Cancelled.')
  })

  it('refuses a version of the protocol it does not speak', async () => {
    const error = await failure(open({ MOCK_PROTOCOL: '2' }))
    expect(error.message).toBe('Mock speaks version 2 of the Agent Client Protocol, and Cubex speaks version 1.')
  })

  it('says so when the agent opens no session', async () => {
    const error = await failure(open({ MOCK_NO_SESSION_ID: '1' }))
    expect(error.message).toBe('Mock did not open a session.')
  })
})

describe('signing in', () => {
  it('signs in with the only way the agent offers, then opens the session', async () => {
    const agent = await open({ MOCK_AUTH: 'required' })
    expect(methods()).toEqual(['initialize', 'session/new', 'authenticate', 'session/new'])
    expect(recorded()[2]!.params).toEqual({ methodId: 'login' })
    expect(agent.alive).toBe(true)
  })

  const TWO = JSON.stringify([{ id: 'oauth', name: 'Log in with a browser' }, { id: 'key', name: 'API key' }])

  it('uses the way the person chose when there are several', async () => {
    await open({ MOCK_AUTH: 'required', MOCK_AUTH_METHODS: TWO }, {}, { authMethod: 'key' })
    expect(recorded().find((message) => message.method === 'authenticate')!.params).toEqual({ methodId: 'key' })
  })

  it('lists the ways, and says where to choose one, when there are several and none was chosen', async () => {
    const error = await failure(open({ MOCK_AUTH: 'required', MOCK_AUTH_METHODS: TWO }))
    expect(error.message).toBe('Mock asks to be signed in and offers more than one way: oauth (Log in with a browser), key (API key).')
    expect(error.hint).toContain('Sign-in method')
    expect(methods()).not.toContain('authenticate')
  })

  it('says so when the only way is one that needs a terminal', async () => {
    const error = await failure(open({ MOCK_AUTH: 'required', MOCK_AUTH_METHODS: JSON.stringify([{ id: 't', name: 'Terminal login', type: 'terminal', args: ['login'] }]) }))
    expect(error.message).toBe('Mock asks to be signed in, and offers no way that Cubex can use.')
    expect(error.hint).toContain('terminal')
  })

  it('says what happened when the sign-in is refused', async () => {
    const error = await failure(open({ MOCK_AUTH: 'required', MOCK_AUTH_FAIL: '1' }))
    expect(error.message).toBe('Mock could not sign in with "login": Login was refused.')
    expect(error.hint).toContain('Variables to pass')
  })
})

describe('the mode it works in', () => {
  const CLAUDE: Array<[string, string]> = [['default', 'Default'], ['acceptEdits', 'Accept Edits'], ['plan', 'Plan Mode'], ['bypassPermissions', 'Bypass Permissions']]

  it('moves the agent into its most careful mode', async () => {
    await open({ MOCK_MODES: MODES('default', CLAUDE) })
    expect(recorded().find((message) => message.method === 'session/set_mode')!.params).toEqual({ sessionId: 'mock-session-1', modeId: 'plan' })
  })

  it('does that through the option an agent offers its modes as', async () => {
    await open({ MOCK_MODES: MODES('default', CLAUDE), MOCK_MODES_VIA: 'config' })
    expect(recorded().find((message) => message.method === 'session/set_config_option')!.params).toEqual({ sessionId: 'mock-session-1', configId: 'mode', value: 'plan' })
    expect(methods()).not.toContain('session/set_mode')
  })

  it('leaves an agent that is already as careful as it gets', async () => {
    await open({ MOCK_MODES: MODES('plan', CLAUDE) })
    expect(methods()).toEqual(['initialize', 'session/new'])
  })

  it('goes on when the agent will not change mode but is in one that asks first', async () => {
    const agent = await open({ MOCK_MODES: MODES('default', [['default', 'Default'], ['plan', 'Plan']]), MOCK_SET_MODE_FAIL: '1' })
    expect(agent.alive).toBe(true)
  })

  it('refuses an agent that will not change mode and is in one that does not ask', async () => {
    const error = await failure(open({ MOCK_MODES: MODES('yolo', [['yolo', 'YOLO'], ['plan', 'Plan']]), MOCK_SET_MODE_FAIL: '1' }))
    expect(error.message).toBe('Mock would not switch to its "Plan" mode, and the mode it is in is not one that asks first.')
  })

  it('refuses an agent that is in a mode that does not ask and has no other', async () => {
    const error = await failure(open({ MOCK_MODES: MODES('bypassPermissions', [['bypassPermissions', 'Bypass Permissions']]) }))
    expect(error.message).toBe('Mock is in the mode "Bypass Permissions", which makes changes without asking, and it has no mode that asks first.')
    expect(error.hint).toContain('asks before it acts')
  })

  it('refuses a mode it cannot tell is careful, and says that, not that it is unsafe', async () => {
    const error = await failure(open({ MOCK_MODES: MODES('code', [['code', 'Code']]) }))
    expect(error.message).toBe('Mock is in the mode "Code", and Cubex cannot tell that it asks before it makes changes.')
  })

  it('stops an agent that moves itself into a mode that does not ask', async () => {
    const agent = await open({ MOCK_MODES: MODES('plan', [['plan', 'Plan'], ['yolo', 'YOLO']]) })
    const error = await failure(agent.prompt('@mock mode yolo'))
    expect(error.message).toBe('Mock moved itself into the mode "YOLO", which makes changes without asking, and was stopped.')
    await vi.waitFor(() => expect(agent.alive).toBe(false))
  })

  it('lets an agent move itself between careful modes', async () => {
    const agent = await open({ MOCK_MODES: MODES('plan', [['plan', 'Plan'], ['default', 'Default']]) })
    expect((await agent.prompt('@mock mode default')).text).toBe('mode changed')
    expect(agent.alive).toBe(true)
  })

  it('knows from the modes it offered whether it could take a task that changes the project', async () => {
    expect((await open({ MOCK_MODES: MODES('default', CLAUDE) })).taskReadiness()).toEqual({ ready: true, mode: { id: 'default', name: 'Default' } })
    // The mode it was moved into for the question does not matter: it is what it offers that counts.
    expect((await open({ MOCK_MODES: MODES('plan', CLAUDE) })).taskReadiness()).toEqual({ ready: true, mode: { id: 'default', name: 'Default' } })
    expect((await open({ MOCK_MODES: MODES('default', CLAUDE), MOCK_MODES_VIA: 'config' })).taskReadiness()).toEqual({ ready: true, mode: { id: 'default', name: 'Default' } })
    expect((await open({ MOCK_MODES: MODES('build', [['build', 'Build'], ['plan', 'Plan']]) })).taskReadiness())
      .toEqual({ ready: false, offered: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] })
    expect((await open()).taskReadiness()).toEqual({ ready: true })
  })
})

describe('asking', () => {
  it('sends the message as text, and returns what the agent said', async () => {
    const agent = await open()
    const reply = await agent.prompt('Is it safe?')
    expect(reply).toEqual({ text: 'OK.\nVerdict: agree', stopReason: 'end_turn', capped: false })
    const sent = recorded().find((message) => message.method === 'session/prompt')!
    expect(sent.params).toEqual({ sessionId: 'mock-session-1', prompt: [{ type: 'text', text: 'Is it safe?' }] })
  })

  it('keeps one session for many messages', async () => {
    const agent = await open()
    const first = (await agent.prompt('@mock pid')).text
    const second = (await agent.prompt('@mock pid')).text
    expect(second).toBe(first)
    expect(methods().filter((method) => method === 'session/new')).toHaveLength(1)
  })

  it('joins what comes in pieces, and starts a new paragraph after a tool call', async () => {
    const agent = await open()
    expect((await agent.prompt('@mock chunks Hel|lo, |world')).text).toBe('Hello, world')
    expect((await agent.prompt('@mock tool-between I will look at the file.|The migration is safe.')).text).toBe('I will look at the file.\n\nThe migration is safe.')
  })

  it('keeps a long reply to the most it keeps, and says it was cut', async () => {
    const agent = await open()
    const reply = await agent.prompt(`@mock say ${'x'.repeat(REPLY_COLLECT_CAP + 5_000)}`)
    expect(reply.capped).toBe(true)
    expect(reply.text).toHaveLength(REPLY_COLLECT_CAP)
  })

  it('returns how the agent ended its turn when it did not finish well', async () => {
    const agent = await open()
    expect((await agent.prompt('@mock refuse')).stopReason).toBe('refusal')
    expect(await agent.prompt('@mock max_tokens')).toMatchObject({ stopReason: 'max_tokens', text: 'Cut off' })
    expect(await agent.prompt('@mock max_turn_requests')).toMatchObject({ stopReason: 'max_turn_requests', text: '' })
    expect(await agent.prompt('@mock empty')).toMatchObject({ stopReason: 'end_turn', text: '' })
  })

  it('reports an error the agent answers with', async () => {
    const agent = await open()
    const error = await failure(agent.prompt('@mock error'))
    expect(error.message).toBe('The model is overloaded. Try again later.')
  })

  it('answers one message at a time', async () => {
    const agent = await open()
    const first = agent.prompt('@mock hang')
    const second = await failure(agent.prompt('x'))
    expect(second.message).toBe('Mock is still answering another message.')
    agent.kill(true)
    await first.catch(() => undefined)
  })

  it('reports a program that ends while it answers', async () => {
    const agent = await open({ MOCK_EXIT_AT_PROMPT: '1', MOCK_STDERR: 'panic: out of memory\n' })
    const error = await failure(agent.prompt('x'))
    expect(error.message).toBe('Mock stopped unexpectedly with exit code 1.')
    expect(error.output).toContain('out of memory')
    expect(agent.alive).toBe(false)
    expect((await failure(agent.prompt('again'))).message).toBe('Mock is no longer running.')
  })
})

describe('what the agent asks of Cubex', () => {
  const answer = (text: string): unknown => JSON.parse(text.replace('permission:', '')) as unknown

  it('may look inside its folder, once', async () => {
    const agent = await open()
    expect(answer((await agent.prompt('@mock permission read src/a.ts')).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(answer((await agent.prompt('@mock permission search')).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })

  it('may not look outside its folder', async () => {
    const agent = await open()
    expect(answer((await agent.prompt('@mock permission read ../outside.txt')).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
  })

  it.each(['edit', 'execute', 'delete', 'fetch', 'switch_mode'])('is told no to %s', async (kind) => {
    const agent = await open()
    expect(answer((await agent.prompt(`@mock permission ${kind} src/a.ts`)).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
  })

  it('is told that Cubex does not read or write files or run commands for it', async () => {
    const agent = await open()
    expect((await agent.prompt('@mock fs')).text).toBe('fs:-32601')
    expect(agent.alive).toBe(true)
  })
})

describe('stopping a message', () => {
  it('tells the agent to stop, and reports the message as cancelled', async () => {
    const controller = new AbortController()
    const agent = await open()
    const asked = agent.prompt('@mock hang', { signal: controller.signal })
    await vi.waitFor(() => expect(methods()).toContain('session/prompt'))
    controller.abort()
    expect((await failure(asked)).message).toBe('Cancelled.')
    expect(recorded().find((message) => message.method === 'session/cancel')!.params).toEqual({ sessionId: 'mock-session-1' })
  })

  it('does not send a message when it is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const agent = await open()
    expect((await failure(agent.prompt('x', { signal: controller.signal }))).message).toBe('Cancelled.')
    expect(methods()).not.toContain('session/prompt')
  })

  it('stops an agent that does not wrap up after being told to', async () => {
    const controller = new AbortController()
    const agent = await open({ MOCK_CANCEL_LATE: '1' }, { cancelGraceMs: 250 })
    const asked = agent.prompt('@mock hang', { signal: controller.signal })
    await vi.waitFor(() => expect(methods()).toContain('session/prompt'))
    controller.abort()
    expect((await failure(asked)).message).toBe('Cancelled.')
    expect(agent.alive).toBe(false)
  })

  it('gives up on an agent that takes too long, and says how long that was', async () => {
    const agent = await open()
    const error = await failure(agent.prompt('@mock hang', { timeoutMs: 400 }))
    expect(error.message).toBe('Mock did not answer within 1 second and was stopped.')
    expect(error.hint).toContain('smaller question')
  })
})

describe('ending', () => {
  it('lets the program end by itself when its input closes', async () => {
    const agent = await open()
    await agent.close()
    expect(agent.alive).toBe(false)
  })

  it('stops the program for good, at once when the app is quitting', async () => {
    const agent = await open()
    const pid = Number((await agent.prompt('@mock pid')).text)
    agent.kill(true)
    expect(agent.alive).toBe(false)
    await vi.waitFor(() => {
      let running = true
      try { process.kill(pid, 0) } catch { running = false }
      expect(running).toBe(false)
    }, { timeout: 5_000 })
  })

  it('can be stopped twice', async () => {
    const agent = await open()
    agent.kill()
    agent.kill(true)
    await agent.close()
    expect(agent.alive).toBe(false)
  })
})
