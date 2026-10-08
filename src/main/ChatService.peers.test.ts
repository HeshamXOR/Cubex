import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode, ToolActivity } from '@shared/ipc'
import type { PeerConfig } from '@shared/peers'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({
  dataRoot: '', workspace: '', peers: undefined as unknown, localOnly: false, usage: [] as unknown[]
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) }
}))
vi.mock('./config', () => ({
  getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], peers: mocks.peers, privacy: { localOnly: mocks.localOnly } })
}))
vi.mock('./cost', () => ({ recordUsage: (usage: unknown) => { mocks.usage.push(usage) } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let root: string
let marker: string
let script: string
let services: ChatService[] = []

// A stand-in for Claude Code or any program: it notes that it ran, and answers with what it was asked.
const FAKE_PROGRAM = `
const fs = require('fs'); const marker = process.argv[2]
let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c })
process.stdin.on('end', () => {
  fs.appendFileSync(marker, 'run\\n')
  const m = /The agent's message:\\n\\n([\\s\\S]*)$/.exec(d)
  process.stdout.write('Heard: ' + (m ? m[1] : '?') + ' (' + (d.includes('Earlier in this conversation') ? 'with history' : 'fresh') + ')\\nVerdict: partly agree')
})`

const peer = (over: Partial<PeerConfig> = {}): PeerConfig => ({
  kind: 'cli', id: 'fake', name: 'Fake Agent', enabled: true, preset: 'custom', command: process.execPath, args: [script, marker], input: 'stdin', ...over
} as PeerConfig)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-peers-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.localOnly = false
  mocks.usage = []
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
  marker = join(root, 'ran.txt')
  script = join(root, 'fake.cjs')
  writeFileSync(script, FAKE_PROGRAM)
  mocks.peers = { list: [peer()], maxRounds: 3 }
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string
const runs = (): number => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0)

interface Harness {
  service: ChatService
  requests: AIRequest[]
  modelAsks: AIRequest[]
  turn(script: Step[], options?: { mode?: PermissionMode; answers?: PermissionDecision[]; peers?: string[]; conversationId?: string }): Promise<ChatEvent[]>
}

function harness(): Harness {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  const modelAsks: AIRequest[] = []
  let steps: Step[] = []
  let used = 0
  let answers: PermissionDecision[] = []
  let turns = 0
  const provider = {
    id: 'p', name: 'Provider',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(request)
      const step = steps[used++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    },
    // A model that is one of the other agents is asked with a plain request.
    async sendMessage(request: AIRequest): Promise<AIResponse> {
      modelAsks.push(request)
      return { id: 'r', provider: 'p', model: 'peer-model', content: [], text: 'Model view.\nVerdict: agree', toolCalls: [], stopReason: 'stop', createdAt: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as unknown as AIResponse
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') {
      const decision = answers.shift() ?? 'deny'
      queueMicrotask(() => service.resolvePermission(event.ask.id, decision))
    }
  })
  services.push(service)
  return {
    service, requests, modelAsks,
    async turn(turnSteps, { mode = 'default', answers: turnAnswers = [], peers, conversationId = 'c1' } = {}) {
      steps = turnSteps; used = 0; answers = [...turnAnswers]
      const from = events.length
      const request: ChatStartRequest = {
        streamId: `s${++turns}`, conversationId, messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy,
        ...(peers ? { peers } : {})
      }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 10_000 })
      return events.slice(from)
    }
  }
}

const consult = (id: string, message: string, agent = 'fake'): ToolCall => ({ id, name: 'consult_agent', input: { agent, message } })
const asks = (events: ChatEvent[]): PermissionAsk[] => events.flatMap((e) => (e.kind === 'permission' ? [e.ask] : []))
const tools = (events: ChatEvent[], id: string): ToolActivity[] => events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool] : []))
const finalTool = (events: ChatEvent[], id: string): ToolActivity => tools(events, id).at(-1)!
const toolNames = (request: AIRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name)

describe('offering other agents', () => {
  it('offers the tool, and tells the model how to use it, only for agents the chat turned on', async () => {
    const h = harness()
    await h.turn(['hello'], { peers: ['fake'] })
    expect(toolNames(h.requests[0])).toContain('consult_agent')
    expect(String(h.requests[0]!.system)).toContain('consult_agent asks another AI agent')
    expect(JSON.stringify(h.requests[0]!.tools)).toContain('fake: Fake Agent (a program on this computer; it sees only your message)')
  })

  it.each([
    ['nothing turned on', undefined],
    ['an empty list', []],
    ['an agent that does not exist', ['nobody']],
    ['malformed ids', ['../x', 5 as unknown as string]]
  ])('does not offer it for %s', async (_name, peers) => {
    const h = harness()
    await h.turn(['hello'], { peers })
    expect(toolNames(h.requests[0])).not.toContain('consult_agent')
    expect(String(h.requests[0]!.system)).not.toContain('consult_agent asks')
  })

  it('does not offer an agent that is off in settings', async () => {
    mocks.peers = { list: [peer({ enabled: false })], maxRounds: 3 }
    const h = harness()
    await h.turn(['hello'], { peers: ['fake'] })
    expect(toolNames(h.requests[0])).not.toContain('consult_agent')
  })

  it('leaves out programs in local-only mode, and keeps models', async () => {
    mocks.localOnly = true
    mocks.peers = { list: [peer(), { kind: 'model', id: 'gpt', name: 'GPT', enabled: true, providerId: 'p', model: 'peer-model' }], maxRounds: 3 }
    const h = harness()
    await h.turn(['hello'], { peers: ['fake', 'gpt'] })
    const description = JSON.stringify(h.requests[0]!.tools)
    expect(description).toContain('gpt: GPT')
    expect(description).not.toContain('fake: Fake Agent')
  })

  it('uses the rounds from settings', async () => {
    mocks.peers = { list: [peer()], maxRounds: 5 }
    const h = harness()
    await h.turn(['hello'], { peers: ['fake'] })
    expect(JSON.stringify(h.requests[0]!.tools)).toContain('at most 5 messages')
  })
})

describe('a talk with another agent', () => {
  it('asks once, with the whole message in front of the person, then runs it', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'Is the lock order safe?\nHere is the code: a(); b();')], 'finished'], { peers: ['fake'], answers: ['allow'] })
    const [ask] = asks(events)
    expect(asks(events)).toHaveLength(1)
    expect(ask).toMatchObject({ toolName: 'consult_agent', title: 'Ask Fake Agent' })
    expect(ask!.detail).toBe('To Fake Agent:\n\nIs the lock order safe?\nHere is the code: a(); b();')
    expect(ask!.risks?.[0]).toContain(`Starts "${process.execPath}" on this computer and sends it your message.`)
    // A message that leaves the computer is never approved for good.
    expect(ask!.rule).toBeUndefined()
    expect(runs()).toBe(1)
    const done = finalTool(events, 'k1')
    expect(done).toMatchObject({ phase: 'done', title: 'Ask Fake Agent' })
    expect(done.peer).toMatchObject({ name: 'Fake Agent', round: 1, of: 3, verdict: 'partly' })
    expect(done.detail).toContain('Heard: Is the lock order safe?')
    expect(done.detail).not.toContain('Verdict:')
    // The model got the reply as data, wrapped.
    const toolResult = JSON.stringify(h.requests[1]!.messages)
    expect(toolResult).toContain('<agent_reply agent=\\"fake\\">')
    expect(toolResult).toContain('Round 1 of 3 with Fake Agent')
  })

  it('does not run the program when the person says no', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'secret plans')], 'ok'], { peers: ['fake'], answers: ['deny'] })
    expect(runs()).toBe(0)
    expect(finalTool(events, 'k1')).toMatchObject({ phase: 'error', detail: 'Denied by user' })
  })

  it('does not ask again for later messages to the same agent in the turn, up to the round limit', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'one')], [consult('k2', 'two')], [consult('k3', 'three')], [consult('k4', 'four')], 'wrap up'], { peers: ['fake'], answers: ['allow'] })
    expect(asks(events)).toHaveLength(1)
    expect(runs()).toBe(3)
    expect(finalTool(events, 'k2').peer).toMatchObject({ round: 2, of: 3 })
    expect(finalTool(events, 'k3').peer).toMatchObject({ round: 3, of: 3 })
    const fourth = finalTool(events, 'k4')
    expect(fourth.phase).toBe('error')
    expect(fourth.detail).toContain('which is the limit')
  })

  it('carries the talk into the next turn, and asks again there', async () => {
    const h = harness()
    await h.turn([[consult('k1', 'first turn question')], 'done'], { peers: ['fake'], answers: ['allow'] })
    const events = await h.turn([[consult('k2', 'second turn question')], 'done'], { peers: ['fake'], answers: ['allow'] })
    expect(asks(events)).toHaveLength(1)
    expect(finalTool(events, 'k2').detail).toContain('(with history)')
    expect(finalTool(events, 'k2').peer?.round).toBe(1)
  })

  it('forgets the talk when the task is deleted', async () => {
    const h = harness()
    await h.turn([[consult('k1', 'before')], 'done'], { peers: ['fake'], answers: ['allow'] })
    h.service.forgetConversation('c1')
    const events = await h.turn([[consult('k2', 'after')], 'done'], { peers: ['fake'], answers: ['allow'] })
    expect(finalTool(events, 'k2').detail).toContain('(fresh)')
  })

  it('asks separately for each agent', async () => {
    mocks.peers = { list: [peer(), peer({ id: 'other', name: 'Other Agent' })], maxRounds: 3 }
    const h = harness()
    const events = await h.turn([[consult('k1', 'one')], [consult('k2', 'two', 'other')], [consult('k3', 'three')], 'done'], { peers: ['fake', 'other'], answers: ['allow', 'allow'] })
    expect(asks(events).map((ask) => ask.title)).toEqual(['Ask Fake Agent', 'Ask Other Agent'])
    expect(runs()).toBe(3)
  })

  it('does not ask for a call that names an agent that is not offered, and sends nothing', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'hi', 'stranger')], 'done'], { peers: ['fake'] })
    expect(asks(events)).toHaveLength(0)
    expect(runs()).toBe(0)
    expect(finalTool(events, 'k1').phase).toBe('error')
    expect(finalTool(events, 'k1').detail).toContain('There is no agent "stranger"')
  })
})

describe('how it fits the permission modes', () => {
  it('works in plan mode, where it changes nothing in the project, and still asks', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'plan question')], 'done'], { mode: 'plan', peers: ['fake'], answers: ['allow'] })
    expect(asks(events)).toHaveLength(1)
    expect(finalTool(events, 'k1').phase).toBe('done')
  })

  it('asks in accept-edits mode, which only approves edits', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'q')], 'done'], { mode: 'acceptEdits', peers: ['fake'], answers: ['allow'] })
    expect(asks(events)).toHaveLength(1)
  })

  it('does not ask when the person chose to bypass permissions', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'q')], 'done'], { mode: 'bypass', peers: ['fake'] })
    expect(asks(events)).toHaveLength(0)
    expect(finalTool(events, 'k1').phase).toBe('done')
  })
})

describe('a model as the other agent', () => {
  beforeEach(() => {
    mocks.peers = { list: [{ kind: 'model', id: 'gpt', name: 'GPT', enabled: true, providerId: 'p', model: 'peer-model' }], maxRounds: 3 }
  })

  it('is asked with a plain request, and its usage is recorded', async () => {
    const h = harness()
    const events = await h.turn([[consult('k1', 'Which index should I add?', 'gpt')], 'done'], { peers: ['gpt'], answers: ['allow'] })
    expect(asks(events)[0]!.risks?.[0]).toBe('Sends your message to peer-model. Anything in it leaves this computer unless that model runs on it.')
    expect(h.modelAsks).toHaveLength(1)
    expect(h.modelAsks[0]!.model).toBe('peer-model')
    expect(String(h.modelAsks[0]!.system)).toContain('Verdict: agree')
    expect(h.modelAsks[0]!.tools).toBeUndefined()
    expect(JSON.stringify(h.modelAsks[0]!.messages)).toContain('Which index should I add?')
    expect(finalTool(events, 'k1').peer).toMatchObject({ name: 'GPT', round: 1, verdict: 'agree' })
    expect(mocks.usage).toHaveLength(1)
  })
})
