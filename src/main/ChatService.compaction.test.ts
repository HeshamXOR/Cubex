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
  /** The context snapshots a turn kept with the task: not part of what a compaction writes. */
  saved: [] as unknown[],
  recordUsage: vi.fn()
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: {
    get: () => (mocks.conversation ? structuredClone(mocks.conversation) : null),
    update: (_id: string, patch: Partial<Conversation>) => {
      if ('lastContext' in patch) mocks.saved.push(patch.lastContext)
      else mocks.updates.push(patch)
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
  mocks.saved = []
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
    // What the task keeps for the next time it is opened is that post-compaction snapshot, not the one before the summary.
    await vi.waitFor(() => expect(mocks.saved).toEqual([snapshot?.kind === 'context' ? snapshot.context : undefined]))
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
    // The summary ends with a note on the todo list the agent had written by then.
    expect(textOf(last)[0]).toContain(SUMMARY)
    expect(textOf(last)[0]).toContain('Todo list:')
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
})
