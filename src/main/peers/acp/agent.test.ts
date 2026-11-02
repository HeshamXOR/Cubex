import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPeer } from '@shared/peers'
import { removeFolder } from '../../testing/removeFolder'
import { AcpAgent, AcpFailure, type OpenOptions } from './agent'

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

  it('stops a program that never answers the handshake', async () => {
    const error = await failure(open({ MOCK_HANG_START: '1' }, { startTimeoutMs: 400 }))
    expect(error.message).toBe('Mock did not get ready within 1 second and was stopped.')
    expect(error.hint).toContain('Agent Client Protocol')
  })

  it('refuses a version of the protocol it does not speak', async () => {
    const error = await failure(open({ MOCK_PROTOCOL: '2' }))
    expect(error.message).toBe('Mock speaks version 2 of the Agent Client Protocol, and Cubex speaks version 1.')
  })
})

describe('signing in', () => {
  it('signs in with the only way the agent offers, then opens the session', async () => {
    const agent = await open({ MOCK_AUTH: 'required' })
    expect(methods()).toEqual(['initialize', 'session/new', 'authenticate', 'session/new'])
    expect(recorded()[2]!.params).toEqual({ methodId: 'login' })
    expect(agent.alive).toBe(true)
  })

})

describe('the mode it works in', () => {
  const CLAUDE: Array<[string, string]> = [['default', 'Default'], ['acceptEdits', 'Accept Edits'], ['plan', 'Plan Mode'], ['bypassPermissions', 'Bypass Permissions']]

  it('moves the agent into its most careful mode', async () => {
    await open({ MOCK_MODES: MODES('default', CLAUDE) })
    expect(recorded().find((message) => message.method === 'session/set_mode')!.params).toEqual({ sessionId: 'mock-session-1', modeId: 'plan' })
  })

  it('refuses an agent that will not change mode and is in one that does not ask', async () => {
    const error = await failure(open({ MOCK_MODES: MODES('yolo', [['yolo', 'YOLO'], ['plan', 'Plan']]), MOCK_SET_MODE_FAIL: '1' }))
    expect(error.message).toBe('Mock would not switch to its "Plan" mode, and the mode it is in is not one that asks first.')
  })

  it('stops an agent that moves itself into a mode that does not ask', async () => {
    const agent = await open({ MOCK_MODES: MODES('plan', [['plan', 'Plan'], ['yolo', 'YOLO']]) })
    const error = await failure(agent.prompt('@mock mode yolo'))
    expect(error.message).toBe('Mock moved itself into the mode "YOLO", which makes changes without asking, and was stopped.')
    await vi.waitFor(() => expect(agent.alive).toBe(false))
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
})

describe('what the agent asks of Cubex', () => {
  const answer = (text: string): unknown => JSON.parse(text.replace('permission:', '')) as unknown

  it('may not look outside its folder', async () => {
    const agent = await open()
    expect(answer((await agent.prompt('@mock permission read ../outside.txt')).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
  })

  it.each(['edit', 'execute', 'delete', 'fetch', 'switch_mode'])('is told no to %s', async (kind) => {
    const agent = await open()
    expect(answer((await agent.prompt(`@mock permission ${kind} src/a.ts`)).text)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
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
})

describe('ending', () => {

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
})
