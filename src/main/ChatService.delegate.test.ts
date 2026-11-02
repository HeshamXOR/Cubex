import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode } from '@shared/ipc'
import type { AcpPeer } from '@shared/peers'
import type { ProviderManager } from './ProviderManager'
import { removeFolder } from './testing/removeFolder'

// Delegated tasks through the real service: a scripted model calls the tool, a real program (the stand-in agent) does the work.
const MOCK = fileURLToPath(new URL('./peers/acp/testing/mockAgent.cjs', import.meta.url))
const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '', peers: [] as unknown[] }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace || undefined, messages: [] } : null) }
}))
vi.mock('./config', () => ({
  getSettings: () => ({
    general: { workspacePath: mocks.workspace || undefined }, mcpServers: [], hooks: [], privacy: { localOnly: false }, shell: { preferred: 'auto' },
    peers: { list: mocks.peers, maxRounds: 3 }
  })
}))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []
const CLAUDE_MODES = JSON.stringify({ current: 'plan', available: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept Edits' }, { id: 'plan', name: 'Plan Mode' }, { id: 'bypassPermissions', name: 'Bypass Permissions' }] })
const OPENCODE_MODES = JSON.stringify({ current: 'build', available: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] })

const agent = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'mock', name: 'Mock', enabled: true, preset: 'custom', command: process.execPath, args: [MOCK], canDelegate: true, ...over })
const file = (name: string): string => join(mocks.workspace, name)

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-delegate-chat-')))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
  writeFileSync(file('notes.txt'), 'hello')
  mocks.peers = [agent()]
  process.env.MOCK_MODES = CLAUDE_MODES
})
afterEach(async () => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  delete process.env.MOCK_MODES
  await removeFolder(root)
})

const policy = { primary: { providerId: 'p', model: 'm', params: {} }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
const call = (name: string, input: Record<string, unknown>, id = 'k1'): ToolCall => ({ id, name, input } as ToolCall)
const toolNames = (request: AIRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name)

/** The window's answer to a question; `undefined` leaves it unanswered, as when the person has not looked up yet. */
type Decider = (ask: PermissionAsk) => PermissionDecision | undefined

function harness(decide: Decider = () => 'allow') {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  const asks: PermissionAsk[] = []
  /** How many questions were in front of the person at the same moment, at the most. */
  const onScreen = { now: 0, peak: 0 }
  let steps: Array<ToolCall[] | string> = []
  let used = 0
  let turns = 0
  let service!: ChatService
  const provider = {
    id: 'p', name: 'Provider',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(request)
      const step = steps[used++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') {
      asks.push(event.ask)
      onScreen.now++
      onScreen.peak = Math.max(onScreen.peak, onScreen.now)
      // The window answers once it has drawn the card.
      const decision = decide(event.ask)
      if (decision) setTimeout(() => { onScreen.now--; service.resolvePermission(event.ask.id, decision) }, 5)
    }
  })
  services.push(service)
  return {
    service, requests, events, asks, onScreen,
    async turn(turnSteps: Array<ToolCall[] | string>, mode: PermissionMode = 'default', over: Partial<ChatStartRequest> = {}) {
      steps = turnSteps; used = 0
      const from = events.length
      const request: ChatStartRequest = { streamId: `s${++turns}`, conversationId: 'c1', messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy, peers: ['mock'], ...over }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 30_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      return events.slice(from)
    },
    toolEvents: (all: ChatEvent[], id = 'k1') => all.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool] : []))
  }
}

const task = (text: string, role?: string) => call('delegate_task', { agent: 'mock', task: text, ...(role ? { role } : {}) })

describe('offering the tool', () => {
  it('is offered with the agents that may take tasks, next to consulting them', async () => {
    const h = harness()
    await h.turn(['hi'])
    expect(toolNames(h.requests[0])).toContain('delegate_task')
    expect(toolNames(h.requests[0])).toContain('consult_agent')
  })

  it('is not offered when no agent may take tasks', async () => {
    mocks.peers = [agent({ canDelegate: false })]
    const h = harness()
    await h.turn(['hi'])
    expect(toolNames(h.requests[0])).not.toContain('delegate_task')
    expect(toolNames(h.requests[0])).toContain('consult_agent')
  })
})

describe('a task, from the model to the file', () => {
  it('asks about the task, then about the edit, changes the file and keeps it for review and rewind', async () => {
    const h = harness()
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed\n@mock say Done.`)], 'The agent finished.'])

    // Two questions, in this order: may it have the task, then may it make this edit.
    expect(h.asks).toHaveLength(2)
    expect(h.asks[0]).toMatchObject({ toolName: 'delegate_task', title: 'Delegate to Mock' })
    expect(h.asks[0]!.detail).toMatch(/^To Mock \(implement\):\n\n@mock edit /)
    expect(h.asks[0]!.risks?.join(' ')).toContain('cannot change anything outside the project')
    expect(h.asks[0]!.rule).toBeUndefined()
    expect(h.asks[1]).toMatchObject({ toolName: 'delegate_task', title: 'Mock wants to edit notes.txt', delegate: { agent: 'Mock', action: 'edit', target: 'notes.txt' } })
    expect(h.asks[1]!.detail).toContain('-hello')
    expect(h.asks[1]!.detail).toContain('+changed')
    expect(h.asks[1]!.rule).toBeUndefined()

    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('changed')

    // The row shows the work while it runs and what happened when it is done.
    const rows = h.toolEvents(events)
    expect(rows.some((row) => row.phase === 'running' && row.delegate?.status === 'working')).toBe(true)
    const last = rows.at(-1)!
    expect(last.phase).toBe('done')
    expect(last.title).toBe('Delegate to Mock')
    expect(last.delegate).toMatchObject({ name: 'Mock', role: 'implement', status: 'done', files: [{ path: 'notes.txt', change: 'edited', tracked: true }] })
    expect(last.delegate?.asked).toContain('@mock edit')
    expect(last.detail).toContain('edit:allowed')

    // The model gets the report as another agent's words, with the files, and is told to check.
    const back = JSON.stringify(h.requests[1]!.messages)
    expect(back).toContain('<agent_report agent=')
    expect(back).toContain('Files that changed in the project (1)')
    expect(back).toContain('notes.txt (edited)')
    expect(back).toContain('read what changed and run the checks')

    // The change is in Changes, and Rewind puts the file back.
    const changes = await h.service.getSessionChanges('c1')
    expect(changes).toMatchObject([{ path: 'notes.txt', status: 'modified' }])
    const reverted = await h.service.revertSessionChanges('c1', ['notes.txt'])
    expect(reverted).toMatchObject({ restored: ['notes.txt'], skipped: [] })
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
  })
})

describe('what the person can refuse', () => {
  it('starts nothing when the task is refused', async () => {
    const h = harness((ask) => (ask.delegate ? 'allow' : 'deny'))
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed`)], 'ok'])
    expect(h.asks).toHaveLength(1)
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
    const last = h.toolEvents(events).at(-1)!
    expect(last.phase).toBe('error')
    expect(last.detail).toBe('Denied by user')
    expect(JSON.stringify(h.requests[1]!.messages)).toContain('Permission denied for')
  })

  it('leaves the file alone when the edit is refused, and says so', async () => {
    const h = harness((ask) => (ask.delegate ? 'deny' : 'allow'))
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed`)], 'ok'])
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
    const last = h.toolEvents(events).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.delegate?.files).toEqual([])
    expect(last.detail).toContain('edit:refused')
    expect(await h.service.getSessionChanges('c1')).toEqual([])
  })

  it('does not change what is outside the project, in any mode, and does not ask', async () => {
    const outside = join(root, 'outside.txt')
    for (const mode of ['default', 'acceptEdits', 'bypass'] as const) {
      const h = harness()
      const events = await h.turn([[task(`@mock edit ${outside}|escaped`)], 'ok'], mode)
      expect(existsSync(outside)).toBe(false)
      expect(h.toolEvents(events).at(-1)!.detail).toContain('edit:refused')
      expect(h.asks.filter((ask) => ask.delegate)).toEqual([])
    }
  })
})

describe('plan mode', () => {
  it('blocks a task that would change things', async () => {
    const h = harness()
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed`)], 'ok'], 'plan')
    expect(h.asks).toEqual([])
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
    expect(h.toolEvents(events).at(-1)!.detail).toBe('Blocked in plan mode')
  })

  it('lets a task that only reads through, after asking, and refuses what it tries to change', async () => {
    const h = harness()
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed\n@mock say Reviewed.`, 'review')], 'ok'], 'plan')
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0]!.detail).toMatch(/^To Mock \(review\):/)
    expect(h.asks[0]!.risks?.join(' ')).toContain('not allowed to change anything')
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
    const last = h.toolEvents(events).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.detail).toContain('edit:refused')
    expect(last.detail).toContain('Reviewed.')
  })
})

describe('an agent that cannot be held to the person\'s permission mode', () => {
  it('is not given the task, and the model is told why', async () => {
    process.env.MOCK_MODES = OPENCODE_MODES
    const h = harness()
    const events = await h.turn([[task(`@mock edit ${file('notes.txt')}|changed`)], 'ok'])
    expect(readFileSync(file('notes.txt'), 'utf8')).toBe('hello')
    const last = h.toolEvents(events).at(-1)!
    expect(last.phase).toBe('error')
    expect(JSON.stringify(h.requests[1]!.messages)).toContain('no mode in which it asks before it changes things')
  })
})

describe('stopping', () => {
  it('stops the task with the turn, and keeps what had been changed', async () => {
    const h = harness()
    const started = h.turn([[task(`@mock edit ${file('notes.txt')}|changed\n@mock hang`)], 'ok'], 'acceptEdits', { streamId: 'stop-1' })
    // Wait until the edit has been made, then stop the turn.
    await vi.waitFor(() => expect(readFileSync(file('notes.txt'), 'utf8')).toBe('changed'), { timeout: 30_000 })
    h.service.cancel('stop-1')
    const events = await started
    const last = h.toolEvents(events).at(-1)!
    expect(last.phase).toBe('error')
    expect(last.delegate?.status).toBe('cancelled')
    expect(await h.service.getSessionChanges('c1')).toMatchObject([{ path: 'notes.txt' }])
  }, 60_000)
})
