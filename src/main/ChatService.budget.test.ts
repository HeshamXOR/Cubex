import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent, ModelInfo } from '@core/types'
import type { BudgetNotice, ChatEvent, ChatStartRequest, Conversation, StoredMessage } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  conversation: undefined as unknown as Conversation | undefined,
  settings: {} as Record<string, unknown>,
  /** The usage table: one row per recorded request. */
  rows: [] as Array<{ ts: number; cost: number; conversationId?: string }>,
  /** What every request costs. */
  requestCost: 0.5,
  recorded: [] as Array<{ conversationId?: string; modelId: string }>
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: {
    get: () => (mocks.conversation ? structuredClone(mocks.conversation) : null),
    update: (_id: string, patch: Partial<Conversation>) => { if (mocks.conversation) mocks.conversation = { ...mocks.conversation, ...patch } }
  },
  usageRepo: {
    spendSince: (since: number, conversationId?: string) => mocks.rows
      .filter((row) => row.ts >= since && (conversationId === undefined || row.conversationId === conversationId))
      .reduce((sum, row) => sum + row.cost, 0)
  }
}))
vi.mock('./config', () => ({ getSettings: () => mocks.settings }))
vi.mock('./cost', () => ({
  recordUsage: (params: { conversationId?: string; modelId: string }) => {
    mocks.recorded.push({ conversationId: params.conversationId, modelId: params.modelId })
    mocks.rows.push({ ts: Date.now(), cost: mocks.requestCost, conversationId: params.conversationId })
  }
}))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

const SUMMARY = 'Goal: ship the parser.\n- npm test passes.'
const DAILY_MESSAGE = 'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.'

let services: ChatService[] = []
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-budget-chat-'))
  mocks.rows = []
  mocks.recorded = []
  mocks.requestCost = 0.5
  mocks.conversation = undefined
  mocks.settings = { general: {}, mcpServers: [], hooks: [], ai: { autoCompact: true } }
})
afterEach(() => {
  for (const service of services.splice(0)) { service.cancelAll(); service.dispose() }
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

const withBudget = (budget: Record<string, unknown>) => ({ general: {}, mcpServers: [], hooks: [], ai: { autoCompact: true, budget } })
const message = (id: string, role: StoredMessage['role'], text: string): StoredMessage => ({ id, role, text, createdAt: 1 })
const turns = (count: number): StoredMessage[] => Array.from({ length: count }, (_, index) => [
  message(`u${index + 1}`, 'user', `Question ${index + 1}`), message(`a${index + 1}`, 'assistant', `Answer ${index + 1}`)
]).flat()
const conversation = (): Conversation => ({ id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages: turns(5), providerId: 'primary', model: 'first' })
const request = (overrides: Partial<ChatStartRequest> = {}): ChatStartRequest => ({
  streamId: 'stream-owner', conversationId: 'task', userText: 'Inspect this task', fileToolsEnabled: true,
  policy: { primary: { providerId: 'primary', model: 'first' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} },
  ...overrides
})
const spentToday = (cost: number, conversationId?: string): void => { mocks.rows.push({ ts: Date.now(), cost, conversationId }) }

/** `rounds` requests that each end in a tool call, then one that answers: every request reports its usage. */
function rounds(count: number) {
  return async function* (_req: AIRequest, index: number): AsyncGenerator<AIStreamEvent> {
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    if (index < count) {
      yield { type: 'tool_call', toolCall: { id: `todo${index}`, name: 'todo_write', input: { todos: [{ content: `Step ${index}`, status: 'completed' }] } } }
      yield { type: 'stop', stopReason: 'tool_use' }
    } else {
      yield { type: 'text_delta', text: 'Done.' }
    }
  }
}

function harness(options: { metadata?: Record<string, Partial<ModelInfo>>; stream?: (request: AIRequest, index: number) => AsyncGenerator<AIStreamEvent> } = {}) {
  const events: ChatEvent[] = []
  const streams: AIRequest[] = []
  const sends: AIRequest[] = []
  const primary = {
    id: 'primary',
    streamMessage: async function* (req: AIRequest): AsyncGenerator<AIStreamEvent> {
      streams.push(structuredClone(req))
      yield* (options.stream ?? rounds(0))(req, streams.length - 1)
    },
    sendMessage: async (req: AIRequest): Promise<AIResponse> => {
      sends.push(structuredClone(req))
      return { id: 's', provider: 'primary', model: 'first', content: [{ type: 'text', text: SUMMARY }], text: SUMMARY, toolCalls: [], stopReason: 'stop', createdAt: 1, usage: { inputTokens: 900, outputTokens: 120 } }
    }
  } as unknown as AIProvider
  const manager = {
    resolve: (id: string) => (id === 'primary' ? primary : undefined),
    getModelInfo: (id: string, model: string) => options.metadata?.[`${id}/${model}`]
  } as unknown as ProviderManager
  const service = new ChatService(manager, (event) => { events.push(event) })
  services.push(service)
  return { service, events, streams, sends }
}
async function finished(events: ChatEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
}
const notices = (events: ChatEvent[]): BudgetNotice[] => events.flatMap((event) => (event.kind === 'budget' ? [event.budget] : []))
const replyText = (events: ChatEvent[]): string => events.flatMap((event) => (event.kind === 'stream' && event.event.type === 'text_delta' ? [event.event.text] : [])).join('')
const failed = (events: ChatEvent[]): boolean => events.some((event) => event.kind === 'stream' && event.event.type === 'error')

describe('usage is recorded against its task', () => {
  it('names the task on every request of a turn, so the session budget can add them up', async () => {
    mocks.conversation = conversation()
    const h = harness({ stream: rounds(2) })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(3)
    expect(mocks.recorded).toEqual([
      { conversationId: 'task', modelId: expect.any(String) },
      { conversationId: 'task', modelId: expect.any(String) },
      { conversationId: 'task', modelId: expect.any(String) }
    ])
  })

  it('says nothing about budgets when no cap is set', async () => {
    mocks.conversation = conversation()
    spentToday(500)
    const h = harness({ stream: rounds(2) })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(3)
    expect(notices(h.events)).toEqual([])
  })
})

describe('a daily cap set to stop', () => {
  beforeEach(() => { mocks.conversation = conversation() })

  it('ends the turn before the first request once the day is spent, and says why in the reply', async () => {
    mocks.settings = withBudget({ dailyUsd: 5, action: 'stop' })
    spentToday(5.12)
    const h = harness()
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(0)
    expect(notices(h.events)).toEqual([expect.objectContaining({ scope: 'daily', level: 'over', action: 'stop', stopped: true, limitUsd: 5, message: DAILY_MESSAGE })])
    expect(replyText(h.events)).toContain(DAILY_MESSAGE)
    expect(failed(h.events)).toBe(false)
    // The notice reaches the thread before the turn is declared finished.
    const completed = h.events.findIndex((event) => event.kind === 'stream' && event.event.type === 'completed')
    expect(h.events.findIndex((event) => event.kind === 'budget')).toBeLessThan(completed)
  })

  it('stops between tool rounds, after warning at 80 percent, when a round takes the day to the cap', async () => {
    mocks.settings = withBudget({ dailyUsd: 1.2, action: 'stop' })
    const h = harness({ stream: rounds(5) })
    await h.service.start(request())
    await finished(h.events)
    // Spend before each request: 0, 0.5, 1.0 (83 percent: warn), then 1.5 (over: no fourth request).
    expect(h.streams).toHaveLength(3)
    expect(notices(h.events).map((notice) => [notice.level, notice.stopped])).toEqual([['warn', false], ['over', true]])
    expect(replyText(h.events)).toContain('Daily budget of $1.20 reached.')
    expect(failed(h.events)).toBe(false)
  })

  it('refuses the next turn the same way, every time, until the cap is raised', async () => {
    mocks.settings = withBudget({ dailyUsd: 5, action: 'stop' })
    spentToday(6)
    const h = harness()
    await h.service.start(request({ streamId: 'first' }))
    await finished(h.events)
    h.events.length = 0
    await h.service.start(request({ streamId: 'second' }))
    await finished(h.events)
    expect(notices(h.events)).toHaveLength(1)
    expect(h.streams).toHaveLength(0)

    mocks.settings = withBudget({ dailyUsd: 20, action: 'stop' })
    h.events.length = 0
    await h.service.start(request({ streamId: 'third' }))
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(notices(h.events)).toEqual([])
  })
})

describe('a cap set to warn', () => {
  it('warns once at 80 percent, once at the cap, and never stops the turn', async () => {
    mocks.conversation = conversation()
    mocks.settings = withBudget({ dailyUsd: 1.2, action: 'warn' })
    const h = harness({ stream: rounds(4) })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(5)
    expect(notices(h.events).map((notice) => [notice.level, notice.stopped])).toEqual([['warn', false], ['over', false]])
    expect(notices(h.events)[1]!.message).toContain('keeps going')
    expect(replyText(h.events)).toBe('Done.')
  })
})

describe('the turn and session caps', () => {
  beforeEach(() => { mocks.conversation = conversation() })

  it('ends a turn that has spent its own cap, however much the day has left', async () => {
    mocks.settings = withBudget({ perTurnUsd: 0.8, dailyUsd: 100, action: 'stop' })
    const h = harness({ stream: rounds(5) })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(2)
    expect(notices(h.events)).toEqual([expect.objectContaining({ scope: 'turn', stopped: true, message: 'Turn budget of $0.80 reached. Raise it in Settings, or send a new message to start a fresh turn.' })])
  })

  it('lets the next turn start from zero', async () => {
    mocks.settings = withBudget({ perTurnUsd: 0.8, action: 'stop' })
    const h = harness({ stream: rounds(5) })
    await h.service.start(request({ streamId: 'first' }))
    await finished(h.events)
    expect(h.streams).toHaveLength(2)
    h.events.length = 0
    await h.service.start(request({ streamId: 'second' }))
    await finished(h.events)
    expect(h.streams.length).toBe(4)
  })

  it('counts a task\'s earlier turns, and no other task, against the session cap', async () => {
    mocks.settings = withBudget({ perSessionUsd: 2, action: 'stop' })
    spentToday(1.8, 'task')
    spentToday(50, 'another')
    const h = harness({ stream: rounds(3) })
    await h.service.start(request())
    await finished(h.events)
    // 1.8 is 90 percent: warn; one request later it is 2.3: over.
    expect(h.streams).toHaveLength(1)
    expect(notices(h.events).map((notice) => [notice.scope, notice.level])).toEqual([['session', 'warn'], ['session', 'over']])
    expect(replyText(h.events)).toContain('Session budget of $2.00 reached. Raise it in Settings or start a new session.')
  })
})

describe('what a cap does not touch', () => {
  it('never blocks a local model, which adds nothing to the bill', async () => {
    mocks.conversation = conversation()
    mocks.settings = withBudget({ dailyUsd: 5, action: 'stop' })
    spentToday(9)
    const h = harness({ metadata: { 'primary/first': { location: 'local' } } })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(notices(h.events)).toEqual([])
  })

  it('refuses a summary on demand with the budget\'s sentence, but not one on a local model', async () => {
    mocks.conversation = conversation()
    mocks.settings = withBudget({ dailyUsd: 5, action: 'stop' })
    spentToday(9)
    const cloud = harness()
    expect(await cloud.service.compactConversation('task')).toEqual({ ok: false, error: DAILY_MESSAGE })
    expect(cloud.sends).toHaveLength(0)

    const local = harness({ metadata: { 'primary/first': { location: 'local' } } })
    expect(await local.service.compactConversation('task')).toMatchObject({ ok: true })
  })

  it('counts a summary written during a turn as part of that turn\'s spend', async () => {
    mocks.conversation = conversation()
    mocks.requestCost = 0.6
    mocks.settings = withBudget({ perTurnUsd: 1, action: 'stop' })
    const h = harness({ metadata: { 'primary/first': { contextWindow: 600 } }, stream: rounds(2) })
    await h.service.start(request())
    await finished(h.events)
    // The summary request (0.6) and the first reply (0.6) already pass the cap of 1: no second round.
    expect(h.sends).toHaveLength(1)
    expect(h.streams).toHaveLength(1)
    expect(notices(h.events).some((notice) => notice.scope === 'turn' && notice.stopped)).toBe(true)
  })
})

describe('reading the budget', () => {
  it('reports the day and the task after a turn, and the turn while it runs', async () => {
    mocks.conversation = conversation()
    mocks.settings = withBudget({ dailyUsd: 50 })
    let during: unknown
    let service!: ChatService
    const h = harness({
      stream: async function* (req, index) {
        if (index === 1) during = service.budgetSnapshot('task')
        yield* rounds(1)(req, index)
      }
    })
    service = h.service
    await h.service.start(request())
    await finished(h.events)
    expect(during).toEqual({ turn: 0.5, session: 0.5, daily: 0.5 })
    await vi.waitFor(() => expect(h.service.budgetSnapshot('task')).toEqual({ session: 1, daily: 1 }))
    expect(h.service.budgetSnapshot()).toEqual({ daily: 1 })
  })

  it('applies a change in Settings from the next request, without a restart', async () => {
    mocks.conversation = conversation()
    spentToday(9)
    const h = harness()
    await h.service.start(request({ streamId: 'before' }))
    await finished(h.events)
    expect(h.streams).toHaveLength(1)

    mocks.settings = withBudget({ dailyUsd: 5, action: 'stop' })
    h.events.length = 0
    await h.service.start(request({ streamId: 'after' }))
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(notices(h.events)).toHaveLength(1)
  })
})
