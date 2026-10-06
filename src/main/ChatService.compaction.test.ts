import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY, NormalizedAIError } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent, ModelInfo } from '@core/types'
import type { ChatEvent, ChatStartRequest, CompactionEvent, Conversation, StoredMessage } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'
import { formatSummaryMessage } from './contextHistory'

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  conversation: undefined as unknown as Conversation | undefined,
  settings: {} as Record<string, unknown>,
  updates: [] as Array<Partial<Conversation>>,
  recordUsage: vi.fn()
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: {
    get: () => (mocks.conversation ? structuredClone(mocks.conversation) : null),
    update: (_id: string, patch: Partial<Conversation>) => {
      mocks.updates.push(patch)
      if (mocks.conversation) mocks.conversation = { ...mocks.conversation, ...patch }
    }
  }
}))
vi.mock('./config', () => ({ getSettings: () => mocks.settings }))
vi.mock('./cost', () => ({ recordUsage: mocks.recordUsage }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

const SUMMARY = 'Goal: ship the parser.\n- Chose a hand-written lexer in src/parser/lexer.ts.\n- npm test passes.'
const WINDOW = { 'primary/first': { contextWindow: 14_000 } }

let services: ChatService[] = []
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-compaction-chat-'))
  mocks.updates = []
  mocks.recordUsage.mockClear()
  mocks.settings = { general: {}, mcpServers: [], hooks: [], ai: { autoCompact: true } }
  mocks.conversation = undefined
})
afterEach(() => {
  for (const service of services.splice(0)) { service.cancelAll(); service.dispose() }
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

const message = (id: string, role: StoredMessage['role'], text: string): StoredMessage => ({ id, role, text, createdAt: 1 })
/** u1 a1 u2 a2 ..., each message about `size` characters. */
function turns(count: number, size = 4_000): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => [
    message(`u${index + 1}`, 'user', `Question ${index + 1} ${'q'.repeat(size)}`),
    message(`a${index + 1}`, 'assistant', `Answer ${index + 1} ${'a'.repeat(size)}`)
  ]).flat()
}
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages: turns(6), providerId: 'primary', model: 'first', ...overrides }
}
function request(overrides: Partial<ChatStartRequest> = {}): ChatStartRequest {
  return {
    streamId: 'stream-owner', conversationId: 'task', userText: 'Inspect this task',
    policy: { primary: { providerId: 'primary', model: 'first', params: { maxOutputTokens: 2048 } }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} },
    ...overrides
  }
}
function summaryResponse(text = SUMMARY): AIResponse {
  return { id: 's', provider: 'primary', model: 'first', content: [{ type: 'text', text }], text, toolCalls: [], stopReason: 'stop', createdAt: 1, usage: { inputTokens: 900, outputTokens: 120 } }
}
const textOf = (req: AIRequest): string[] => req.messages.map((item) => (item.content[0]?.type === 'text' ? item.content[0].text : ''))

interface Harness { service: ChatService; events: ChatEvent[]; streams: AIRequest[]; sends: AIRequest[] }
function harness(options: {
  metadata?: Record<string, Partial<ModelInfo>>
  summary?: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>
  stream?: (request: AIRequest, index: number) => AsyncGenerator<AIStreamEvent>
} = {}): Harness {
  const events: ChatEvent[] = []
  const streams: AIRequest[] = []
  const sends: AIRequest[] = []
  const primary = {
    id: 'primary',
    streamMessage: async function* (req: AIRequest): AsyncGenerator<AIStreamEvent> {
      streams.push(structuredClone(req))
      if (options.stream) yield* options.stream(req, streams.length - 1)
      else yield { type: 'text_delta', text: 'Done.' }
    },
    sendMessage: async (req: AIRequest, call?: { signal?: AbortSignal }): Promise<AIResponse> => {
      sends.push(structuredClone(req))
      return options.summary ? options.summary(req, call?.signal) : summaryResponse()
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
async function finished(events: ChatEvent[], timeout = 1_000): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true), { timeout })
}
const compactedEvents = (events: ChatEvent[]) => events.filter((event) => event.kind === 'compacted')
const progressOf = (events: ChatEvent[]): CompactionEvent[] => events.flatMap((event) => (event.kind === 'compaction' ? [event.compaction] : []))

describe('summary injection', () => {
  it('sends the stored summary first, as a user message, ahead of the retained turns', async () => {
    const original = [message('u1', 'user', 'Original request'), message('a1', 'assistant', 'Original reply'), message('u2', 'user', 'Retained request'), message('a2', 'assistant', 'Retained reply')]
    mocks.conversation = conversation({ messages: structuredClone(original), contextStartMessageId: 'u2', contextSummary: SUMMARY })
    const h = harness()
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams[0]!.messages[0]!.role).toBe('user')
    expect(textOf(h.streams[0]!)).toEqual([formatSummaryMessage(SUMMARY), 'Retained request', 'Retained reply', 'Inspect this task'])
    expect(h.streams[0]!.messages[0]!.content).toHaveLength(1)
    expect(mocks.conversation!.messages).toEqual(original)
  })

  it('sends no summary when the boundary is stale, because every message is sent anyway', async () => {
    mocks.conversation = conversation({ messages: turns(2, 10), contextStartMessageId: 'deleted', contextSummary: SUMMARY })
    const h = harness()
    await h.service.start(request())
    await finished(h.events)
    expect(textOf(h.streams[0]!)).toHaveLength(5)
    expect(JSON.stringify(h.streams[0])).not.toContain('conversation_summary')
  })

  it('reports the summary as its own row in the context snapshot', async () => {
    mocks.conversation = conversation({ messages: turns(3, 10), contextStartMessageId: 'u2', contextSummary: SUMMARY })
    const h = harness({ metadata: WINDOW })
    await h.service.start(request())
    await finished(h.events)
    const snapshot = h.events.filter((event) => event.kind === 'context').at(-1)
    const rows = snapshot?.kind === 'context' ? snapshot.context.sections.find((section) => section.id === 'conversation')?.details : undefined
    expect(rows?.map((row) => row.id)).toEqual(['summary', 'messages'])
  })
})

describe('manual compaction', () => {
  it('summarizes older turns on the conversation model and stores the result', async () => {
    mocks.conversation = conversation({ messages: turns(5, 40) })
    const h = harness()
    const result = await h.service.compactConversation('task')
    expect(result).toMatchObject({ ok: true, summary: SUMMARY, boundaryMessageId: 'u4', messagesSummarized: 6 })
    expect(result.ok && result.tokensBefore).toBeGreaterThan(0)
    expect(result.ok && result.tokensAfter).toBeGreaterThan(0)
    expect(h.sends).toHaveLength(1)
    expect(h.streams).toHaveLength(0)
    expect(h.sends[0]).toMatchObject({ model: 'first', stream: false })
    expect(h.sends[0]!.tools).toBeUndefined()
    expect(h.sends[0]!.params).toMatchObject({ reasoningEffort: 'minimal' })
    expect(mocks.updates).toEqual([{ contextStartMessageId: 'u4', contextSummary: SUMMARY, contextSummaryAt: expect.any(Number) }])
    // The summary call is billed like any other request, to the task that asked for it.
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'primary', modelId: 'first', usage: { inputTokens: 900, outputTokens: 120 }, conversationId: 'task'
    }))
  })

  it("uses the model of the task's latest turn rather than the one it was created with", async () => {
    mocks.conversation = conversation({ messages: turns(5, 40), model: 'created-with' })
    const h = harness()
    const base = request()
    await h.service.start({ ...base, policy: { ...base.policy, primary: { providerId: 'primary', model: 'chat-model' } } })
    await finished(h.events)
    await vi.waitFor(async () => expect(await h.service.compactConversation('task')).toMatchObject({ ok: true }))
    expect(h.sends[0]!.model).toBe('chat-model')
  })

  it('asks for a model when the task has none and has not been used', async () => {
    mocks.conversation = conversation({ messages: turns(5, 40), providerId: undefined, model: undefined })
    const h = harness()
    expect(await h.service.compactConversation('task')).toEqual({ ok: false, error: expect.stringMatching(/model/i) })
    expect(h.sends).toHaveLength(0)
  })

  it('reports an unknown task and a task with too little history', async () => {
    const h = harness()
    expect(await h.service.compactConversation('missing')).toEqual({ ok: false, error: 'Conversation not found.' })
    mocks.conversation = conversation({ messages: turns(2, 40) })
    expect(await h.service.compactConversation('task')).toEqual({ ok: false, error: expect.stringMatching(/not enough/i) })
    expect(h.sends).toHaveLength(0)
  })

  it('is refused while a turn is running, and allowed once it ends', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    mocks.conversation = conversation({ messages: turns(5, 40) })
    const h = harness({ stream: async function* () { await gate; yield { type: 'text_delta', text: 'Done.' } } })
    await h.service.start(request())
    expect(await h.service.compactConversation('task')).toEqual({ ok: false, error: expect.stringMatching(/running/i) })
    expect(h.sends).toHaveLength(0)
    expect(mocks.updates).toEqual([])
    open()
    await finished(h.events)
    await vi.waitFor(async () => expect(await h.service.compactConversation('task')).toMatchObject({ ok: true }))
  })

  it('refuses a second compaction and a new turn while one is in flight', async () => {
    let release!: (response: AIResponse) => void
    mocks.conversation = conversation({ messages: turns(5, 40) })
    const h = harness({ summary: () => new Promise<AIResponse>((resolve) => { release = resolve }) })
    const pending = h.service.compactConversation('task')
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    expect(await h.service.compactConversation('task')).toEqual({ ok: false, error: expect.stringMatching(/already/i) })
    await expect(h.service.start(request())).rejects.toThrow(/being compacted/i)
    release(summaryResponse())
    expect(await pending).toMatchObject({ ok: true })
    await h.service.start(request())
    await finished(h.events)
  })

  it('leaves the task untouched when the model call fails', async () => {
    mocks.conversation = conversation({ messages: turns(5, 40) })
    const before = structuredClone(mocks.conversation)
    const h = harness({ summary: async () => { throw new NormalizedAIError({ provider: 'primary', category: 'SERVER_ERROR', classification: 'permanent', retryable: false, message: 'Provider unavailable' }) } })
    expect(await h.service.compactConversation('task')).toEqual({ ok: false, error: expect.stringContaining('Provider unavailable') })
    expect(mocks.updates).toEqual([])
    expect(mocks.conversation).toEqual(before)
  })
})

describe('automatic compaction', () => {
  it('compacts before the request when it reaches 80 percent of the window, announces it and carries on', async () => {
    mocks.conversation = conversation()
    const original = structuredClone(mocks.conversation!.messages)
    const h = harness({ metadata: WINDOW })
    await h.service.start(request())
    await finished(h.events)

    expect(h.sends).toHaveLength(1)
    expect(h.streams).toHaveLength(1)
    // The turn is sent with the summary, the last two turns and the new message only.
    const sent = textOf(h.streams[0]!)
    expect(sent[0]).toBe(formatSummaryMessage(SUMMARY))
    expect(sent).toHaveLength(6)
    expect(sent[1]).toContain('Question 5 ')
    expect(sent.at(-1)).toBe('Inspect this task')
    expect(mocks.conversation!.messages).toEqual(original)
    expect(mocks.updates).toEqual([{ contextStartMessageId: 'u5', contextSummary: SUMMARY, contextSummaryAt: expect.any(Number) }])

    const announced = compactedEvents(h.events)
    expect(announced).toEqual([expect.objectContaining({ streamId: 'stream-owner', conversationId: 'task', kind: 'compacted', summary: SUMMARY, boundaryMessageId: 'u5' })])
    const firstStream = h.events.findIndex((event) => event.kind === 'stream')
    expect(h.events.indexOf(announced[0]!)).toBeLessThan(firstStream)
    // The request the UI sees accounts for the summary.
    const snapshot = h.events.filter((event) => event.kind === 'context').at(-1)
    expect(snapshot?.kind === 'context' ? snapshot.context.sections.find((section) => section.id === 'conversation')?.details?.[0]?.id : undefined).toBe('summary')
  })

  it('folds an earlier summary into the new one', async () => {
    mocks.conversation = conversation({ messages: turns(8), contextStartMessageId: 'u3', contextSummary: 'OLD SUMMARY: chose Postgres.' })
    const h = harness({ metadata: WINDOW })
    await h.service.start(request())
    await finished(h.events)
    const prompt = textOf(h.sends[0]!).join('')
    expect(prompt.match(/<previous_summary>/g)).toHaveLength(1)
    expect(prompt).toContain('OLD SUMMARY: chose Postgres.')
    expect(prompt).not.toContain('Question 2 ')
    expect(mocks.conversation!.contextStartMessageId).toBe('u7')
  })

  // Each row differs from the positive case above in one respect only. The two-turn row uses
  // large messages so the request really is over 80 percent and only the turn count can stop it.
  it.each([
    ['the setting is off', () => { mocks.settings = { general: {}, mcpServers: [], hooks: [], ai: { autoCompact: false } } }, WINDOW, 6, 4_000],
    ['the context window is unknown', () => undefined, {}, 6, 4_000],
    ['there are fewer than three user turns', () => undefined, WINDOW, 2, 30_000],
    ['the request is under 80 percent of the window', () => undefined, { 'primary/first': { contextWindow: 1_000_000 } }, 6, 4_000]
  ])('does not compact when %s', async (_name, arrange, metadata, turnCount, size) => {
    arrange()
    mocks.conversation = conversation({ messages: turns(turnCount, size) })
    const h = harness({ metadata })
    await h.service.start(request())
    await finished(h.events)
    expect(h.sends).toHaveLength(0)
    expect(compactedEvents(h.events)).toEqual([])
    expect(mocks.updates).toEqual([])
    expect(h.streams[0]!.messages).toHaveLength(turnCount * 2 + 1)
  })

  it('counts a gated long-context window as 200k until the user opts in', async () => {
    // About 165k tokens: over 80 percent of 200k, far under 80 percent of 1M.
    const huge = turns(6, 55_000)
    const metadata = { 'primary/first': { contextWindow: 1_000_000, longContextBeta: true } }
    mocks.conversation = conversation({ messages: huge })
    const gated = harness({ metadata })
    await gated.service.start(request())
    await finished(gated.events)
    expect(gated.sends).toHaveLength(1)

    mocks.conversation = conversation({ messages: huge })
    mocks.updates = []
    const open = harness({ metadata })
    await open.service.start(request({ longContext: true }))
    await finished(open.events)
    expect(open.sends).toHaveLength(0)
  })

  it('compacts at most once per turn even if the request stays full', async () => {
    mocks.conversation = conversation()
    const h = harness({
      metadata: { 'primary/first': { contextWindow: 3_000 } },
      stream: async function* (_req, index) {
        if (index === 0) {
          yield { type: 'tool_call', toolCall: { id: 'todo', name: 'todo_write', input: { todos: [{ content: 'Inspect', status: 'completed' }] } } }
          yield { type: 'stop', stopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', text: 'Done.' }
        }
      }
    })
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events)
    expect(h.streams.length).toBeGreaterThanOrEqual(2)
    expect(h.sends).toHaveLength(1)
    expect(compactedEvents(h.events)).toHaveLength(1)
    expect(mocks.updates).toHaveLength(1)
  })

  it('keeps the work of this turn when it compacts between tool rounds', async () => {
    // Round one fits; its large tool result pushes round two over 80 percent.
    // The window leaves room for the 2048-token output reservation as well.
    mocks.conversation = conversation({ messages: turns(6, 1_200) })
    const h = harness({
      metadata: { 'primary/first': { contextWindow: 24_000 } },
      stream: async function* (_req, index) {
        if (index === 0) {
          yield { type: 'text_delta', text: 'Looking.' }
          yield { type: 'tool_call', toolCall: { id: 'todo', name: 'todo_write', input: { todos: [{ content: 'x'.repeat(40_000), status: 'pending' }] } } }
          yield { type: 'stop', stopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', text: 'Done.' }
        }
      }
    })
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events)
    // Round one went out with the full history; compaction happened before round two.
    expect(h.streams).toHaveLength(2)
    expect(h.streams[0]!.messages).toHaveLength(13)
    expect(h.sends).toHaveLength(1)
    expect(compactedEvents(h.events)).toHaveLength(1)
    const last = h.streams[1]!
    // History was replaced by the summary and the last two turns; this turn's user message, call and result survive.
    expect(textOf(last)[0]).toBe(formatSummaryMessage(SUMMARY))
    expect(last.messages.map((item) => item.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'tool'])
    expect(textOf(last)[5]).toBe('Inspect this task')
    expect(last.messages[6]!.content.some((part) => part.type === 'tool_use')).toBe(true)
    expect(last.messages[7]!.content.some((part) => part.type === 'tool_result')).toBe(true)
  })

  it('continues with the full context when the summary fails, and does not retry within the turn', async () => {
    mocks.conversation = conversation()
    const h = harness({
      metadata: WINDOW,
      summary: async () => { throw new NormalizedAIError({ provider: 'primary', category: 'SERVER_ERROR', classification: 'permanent', retryable: false, message: 'Provider unavailable' }) }
    })
    await h.service.start(request())
    await finished(h.events)
    expect(h.sends).toHaveLength(1)
    expect(h.streams).toHaveLength(1)
    expect(h.streams[0]!.messages).toHaveLength(13)
    expect(JSON.stringify(h.streams[0])).not.toContain('conversation_summary')
    expect(compactedEvents(h.events)).toEqual([])
    expect(mocks.updates).toEqual([])
    expect(h.events.filter((event) => event.kind === 'stream' && event.event.type === 'error')).toEqual([])
  })

  it('stops without sending the turn when it is cancelled during compaction', async () => {
    mocks.conversation = conversation()
    const h = harness({
      metadata: WINDOW,
      summary: (_req, signal) => new Promise<AIResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new NormalizedAIError({ provider: 'primary', category: 'CANCELLED', classification: 'permanent', retryable: false, message: 'Cancelled' })))
      })
    })
    await h.service.start(request())
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    h.service.cancel('stream-owner')
    await finished(h.events)
    expect(h.streams).toHaveLength(0)
    expect(mocks.updates).toEqual([])
    expect(compactedEvents(h.events)).toEqual([])
    expect(h.events.some((event) => event.kind === 'stream' && event.event.type === 'completed' && event.event.response.stopReason === 'cancelled')).toBe(true)
    expect(progressOf(h.events).at(-1)).toEqual({ step: 'summarize', phase: 'failed', error: 'Compaction was cancelled.' })
  })

  it('shows the summary being written, then what it saved, before the request goes out', async () => {
    mocks.conversation = conversation()
    const h = harness({ metadata: WINDOW })
    await h.service.start(request())
    await finished(h.events)
    const progress = progressOf(h.events)
    expect(progress.map((item) => `${item.step}:${item.phase}`)).toEqual(['summarize:started', 'summarize:completed'])
    expect(progress[0]).toEqual({ step: 'summarize', phase: 'started', messagesSummarized: 8 })
    expect(progress[1]).toMatchObject({ summary: SUMMARY, boundaryMessageId: 'u5', messagesSummarized: 8 })
    expect(progress[1]!.tokensBefore).toBeGreaterThan(progress[1]!.tokensAfter!)
    const positions = (predicate: (event: ChatEvent) => boolean): number => h.events.findIndex(predicate)
    const started = positions((event) => event.kind === 'compaction' && event.compaction.phase === 'started')
    const completed = positions((event) => event.kind === 'compaction' && event.compaction.phase === 'completed')
    const announced = positions((event) => event.kind === 'compacted')
    const firstRequest = positions((event) => event.kind === 'iteration')
    expect(started).toBeGreaterThanOrEqual(0)
    expect(started).toBeLessThan(completed)
    expect(completed).toBeLessThan(announced)
    expect(announced).toBeLessThan(firstRequest)
  })

  it('tells the thread when the summary could not be written, with the reason, and sends the turn anyway', async () => {
    mocks.conversation = conversation()
    const h = harness({
      metadata: WINDOW,
      summary: async () => { throw new NormalizedAIError({ provider: 'primary', category: 'SERVER_ERROR', classification: 'permanent', retryable: false, message: 'Provider unavailable' }) }
    })
    await h.service.start(request())
    await finished(h.events)
    expect(progressOf(h.events)).toEqual([
      { step: 'summarize', phase: 'started', messagesSummarized: 8 },
      { step: 'summarize', phase: 'failed', error: expect.stringContaining('Provider unavailable') }
    ])
    expect(h.streams).toHaveLength(1)
  })

  it('says nothing about compaction when the request is not due', async () => {
    mocks.conversation = conversation({ messages: turns(6, 10) })
    const h = harness({ metadata: { 'primary/first': { contextWindow: 1_000_000 } } })
    await h.service.start(request())
    await finished(h.events)
    expect(progressOf(h.events)).toEqual([])
  })
})

describe('compaction settings, read on every turn', () => {
  /** About 17k tokens of history in a 30k window: roughly 65 percent of the input budget. */
  const MID = { 'primary/first': { contextWindow: 30_000 } }
  const ai = (compaction: Record<string, unknown>, autoCompact = true) => ({ general: {}, mcpServers: [], hooks: [], ai: { autoCompact, compaction } })

  it('waits for the threshold in Settings, and a change applies to the next turn without a restart', async () => {
    mocks.conversation = conversation()
    const h = harness({ metadata: MID })
    await h.service.start(request({ streamId: 'default-threshold' }))
    await finished(h.events)
    expect(h.sends).toHaveLength(0)

    mocks.settings = ai({ threshold: 0.5 })
    h.events.length = 0
    await h.service.start(request({ streamId: 'lowered-threshold' }))
    await finished(h.events)
    expect(h.sends).toHaveLength(1)
    expect(compactedEvents(h.events)).toHaveLength(1)
  })

  it('does not summarize at a high threshold what it would at the default', async () => {
    // About 16k tokens against a budget of about 18k: 88 percent, past 80 and short of 95.
    const metadata = { 'primary/first': { contextWindow: 22_500 } }
    mocks.conversation = conversation()
    const control = harness({ metadata })
    await control.service.start(request({ streamId: 'default' }))
    await finished(control.events)
    expect(control.sends).toHaveLength(1)

    mocks.conversation = conversation()
    mocks.settings = ai({ threshold: 0.95 })
    const high = harness({ metadata })
    await high.service.start(request({ streamId: 'high' }))
    await finished(high.events)
    expect(high.sends).toHaveLength(0)
  })

  it('follows ai.compaction.auto over the older ai.autoCompact, in both directions', async () => {
    mocks.conversation = conversation()
    mocks.settings = ai({ auto: false }, true)
    const off = harness({ metadata: WINDOW })
    await off.service.start(request({ streamId: 'off' }))
    await finished(off.events)
    expect(off.sends).toHaveLength(0)

    mocks.settings = ai({ auto: true }, false)
    const on = harness({ metadata: WINDOW })
    await on.service.start(request({ streamId: 'on' }))
    await finished(on.events)
    expect(on.sends).toHaveLength(1)
  })
})

describe('pruning old tool output', () => {
  /** Five model requests with real file reads in between: slower than the rest when the machine is busy. */
  const SLOW = 20_000
  let root = ''
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-prune-chat-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** Four reads of about 32k tokens each: the fifth request carries 128k of tool output in a 200k window. */
  function readsFourFiles(settings?: Record<string, unknown>) {
    for (let index = 1; index <= 4; index++) writeFileSync(join(root, `big${index}.txt`), `file ${index}\n${'x'.repeat(100_000)}`)
    if (settings) mocks.settings = settings
    mocks.conversation = conversation({ messages: turns(1, 10), workspacePath: root })
    return harness({
      metadata: { 'primary/first': { contextWindow: 200_000 } },
      stream: async function* (_req, index) {
        if (index < 4) {
          yield { type: 'tool_call', toolCall: { id: `r${index + 1}`, name: 'read_file', input: { path: `big${index + 1}.txt` } } }
          yield { type: 'stop', stopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', text: 'Done.' }
        }
      }
    })
  }
  const resultTexts = (req: AIRequest): string[] => req.messages.flatMap((item) => item.content.flatMap((part) =>
    part.type === 'tool_result' ? [part.content.map((inner) => (inner.type === 'text' ? inner.text : '')).join('')] : []))

  it('replaces the oldest results with stubs once the request passes 60 percent of the budget, and says how much it freed', async () => {
    const h = readsFourFiles()
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events, SLOW)

    expect(h.streams).toHaveLength(5)
    // Nothing was stubbed while the request was small, and the model never lost the newest results.
    for (const early of h.streams.slice(0, 4)) expect(resultTexts(early).some((text) => text.startsWith('[Pruned'))).toBe(false)
    const last = resultTexts(h.streams[4]!)
    expect(last).toHaveLength(4)
    expect(last[0]).toMatch(/^\[Pruned tool output: /)
    expect(last[1]).toMatch(/^\[Pruned tool output: /)
    expect(last[2]).toContain('file 3')
    expect(last[3]).toContain('file 4')

    const pruned = progressOf(h.events).filter((item) => item.step === 'prune')
    expect(pruned).toEqual([{ step: 'prune', phase: 'completed', resultsTrimmed: 2, tokensFreed: expect.any(Number) }])
    expect(pruned[0]!.tokensFreed).toBeGreaterThan(20_000)
    expect(h.sends).toHaveLength(0)
  })

  it('leaves the history alone when pruning is switched off', async () => {
    const h = readsFourFiles({ general: {}, mcpServers: [], hooks: [], ai: { autoCompact: true, compaction: { prune: false } } })
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events, SLOW)
    expect(h.streams).toHaveLength(5)
    expect(resultTexts(h.streams[4]!).some((text) => text.startsWith('[Pruned'))).toBe(false)
    expect(progressOf(h.events)).toEqual([])
  })
})
