import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIMessage, AIRequest, AIResponse, RoutingPolicy } from '@core/types'
import type { CompactionEvent, Conversation, StoredMessage } from '@shared/ipc'
import { CompactionCoordinator, type CompactionHost } from './compactionCoordinator'
import { ContextAnchorStore } from './contextAnchor'
import { estimateContextUsage } from './contextUsage'

const SUMMARY = 'Goal: ship the parser.\n- Chose a hand-written lexer in src/parser/lexer.ts.\n- npm test passes.'
const message = (id: string, role: StoredMessage['role'], text: string): StoredMessage => ({ id, role, text, createdAt: 1 })
function turns(count: number, size = 40): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => [
    message(`u${index + 1}`, 'user', `Question ${index + 1} ${'q'.repeat(size)}`),
    message(`a${index + 1}`, 'assistant', `Answer ${index + 1} ${'a'.repeat(size)}`)
  ]).flat()
}
const policy = (model = 'chat-model', maxOutputTokens?: number): RoutingPolicy => ({
  primary: { providerId: 'p', model, ...(maxOutputTokens ? { params: { maxOutputTokens } } : {}) }, fallbacks: [], fallbackEnabled: false,
  retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {}
})
const response = (text = SUMMARY): AIResponse => ({ id: 'r', provider: 'p', model: 'm', content: [{ type: 'text', text }], text, toolCalls: [], stopReason: 'stop', createdAt: 1 })
const sized = (characters: number): AIRequest => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(characters) }] }] })
const HISTORY: AIMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'rebuilt history' }] }]

function setup(options: {
  conversation?: Partial<Conversation> | null
  window?: { contextWindow?: number; longContextBeta?: boolean }
  settings?: ReturnType<CompactionHost['settings']>
  running?: boolean
  anchor?: ContextAnchorStore
  budgetBlock?: CompactionHost['budgetBlock']
} = {}) {
  let stored: Conversation | null = options.conversation === null ? null : {
    id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages: turns(6), providerId: 'p', model: 'stored-model', ...options.conversation
  }
  const get = vi.fn((_id: string) => (stored ? structuredClone(stored) : null))
  const update = vi.fn((_id: string, patch: Partial<Conversation>) => { if (stored) stored = { ...stored, ...patch } })
  const send = vi.fn(async (_request: AIRequest, _policy: RoutingPolicy, _options?: { signal?: AbortSignal; headers?: Record<string, string>; conversationId?: string }) => response())
  const warn = vi.fn()
  const loadHistory = vi.fn((_id: string) => HISTORY)
  const host: CompactionHost = {
    repo: { get, update }, send,
    modelInfo: () => options.window,
    isRunning: () => options.running ?? false,
    ...(options.budgetBlock ? { budgetBlock: options.budgetBlock } : {}),
    settings: () => options.settings ?? { ai: { autoCompact: true } },
    loadHistory, warn
  }
  return { coordinator: new CompactionCoordinator(host, options.anchor), get, update, send, warn, loadHistory, current: () => stored, set: (next: Conversation | null) => { stored = next } }
}
const WINDOW = { contextWindow: 1_000 }
const SIGNAL = new AbortController().signal
/** About 900 tokens (0.32 per character of unbroken text, 4 for the message): 90 percent of the 1,000-token WINDOW. */
const NEARLY_FULL = sized(2_800)

describe('CompactionCoordinator.compact', () => {
  it('summarizes with the stored provider and model until the task has been used', async () => {
    const t = setup()
    expect(await t.coordinator.compact('task')).toMatchObject({ ok: true, summary: SUMMARY, boundaryMessageId: 'u5', messagesSummarized: 8 })
    expect(t.send.mock.calls[0]![1].primary).toMatchObject({ providerId: 'p', model: 'stored-model' })
    expect(t.coordinator.isCompacting('task')).toBe(false)
  })

  it('is refused with the budget\'s own sentence when a cap set to stop is reached, before any model request', async () => {
    const budgetBlock = vi.fn((_id: string, _target: unknown) => 'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.')
    const t = setup({ budgetBlock })
    expect(await t.coordinator.compact('task')).toEqual({ ok: false, error: 'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.' })
    expect(budgetBlock).toHaveBeenCalledWith('task', expect.objectContaining({ providerId: 'p', model: 'stored-model' }))
    expect(t.send).not.toHaveBeenCalled()
    expect(t.coordinator.isCompacting('task')).toBe(false)
    const open = setup({ budgetBlock: () => undefined })
    expect(await open.coordinator.compact('task')).toMatchObject({ ok: true })
  })

  it('refuses a second compaction while one is in flight and releases the task afterwards, even on failure', async () => {
    const t = setup()
    let release!: (value: AIResponse) => void
    t.send.mockImplementationOnce(() => new Promise<AIResponse>((resolve) => { release = resolve }))
    const first = t.coordinator.compact('task')
    await vi.waitFor(() => expect(t.send).toHaveBeenCalledTimes(1))
    expect(t.coordinator.isCompacting('task')).toBe(true)
    expect(await t.coordinator.compact('task')).toEqual({ ok: false, error: expect.stringMatching(/already/i) })
    release(response())
    expect(await first).toMatchObject({ ok: true })

    t.send.mockRejectedValueOnce(new Error('boom'))
    t.set({ ...t.current()!, contextStartMessageId: undefined, contextSummary: undefined })
    expect(await t.coordinator.compact('task')).toMatchObject({ ok: false })
    expect(t.coordinator.isCompacting('task')).toBe(false)
  })
})

describe('CompactionCoordinator.auto', () => {
  it('compacts a request that reached 80 percent of the window and returns the rebuilt history', async () => {
    const t = setup({ window: WINDOW })
    const result = await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)
    expect(result).toEqual({ attempted: true, compacted: { summary: SUMMARY, boundaryMessageId: 'u5', history: HISTORY } })
    expect(t.loadHistory).toHaveBeenCalledWith('task')
    expect(t.send.mock.calls[0]![1].primary).toMatchObject({ providerId: 'p', model: 'chat-model' })
    expect(t.send.mock.calls[0]![2]?.signal).toBe(SIGNAL)
  })

  it('never throws: storage and history failures are logged and the turn goes on', async () => {
    const broken = setup({ window: WINDOW })
    broken.get.mockImplementation(() => { throw new Error('database is locked') })
    expect(await broken.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: true })
    expect(broken.warn).toHaveBeenCalledWith(expect.stringContaining('database is locked'))

    // The summary was stored, but the rebuilt history could not be read: still announce it.
    const reload = setup({ window: WINDOW })
    reload.loadHistory.mockImplementation(() => { throw new Error('cannot read history') })
    expect(await reload.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({
      attempted: true, compacted: { summary: SUMMARY, boundaryMessageId: 'u5' }
    })
    expect(reload.warn).toHaveBeenCalledWith(expect.stringContaining('cannot read history'))
  })

  it('does not compact while the task is already being compacted by hand', async () => {
    const t = setup({ window: WINDOW })
    let release!: (value: AIResponse) => void
    t.send.mockImplementationOnce(() => new Promise<AIResponse>((resolve) => { release = resolve }))
    const manual = t.coordinator.compact('task')
    await vi.waitFor(() => expect(t.send).toHaveBeenCalledTimes(1))
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    expect(t.send).toHaveBeenCalledTimes(1)
    release(response())
    await manual
  })
})

describe('CompactionCoordinator.auto anchored on reported usage', () => {
  /** Comfortably under 80 percent of the 1000-token window on the estimate alone. */
  const request = sized(1_000)
  const estimated = estimateContextUsage(request, { contextWindow: WINDOW.contextWindow }).estimatedTokens

  it('does not compact on the estimate alone', async () => {
    expect(estimated).toBeLessThan(0.8 * WINDOW.contextWindow)
    const t = setup({ window: WINDOW })
    expect(await t.coordinator.auto('task', request, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
  })

  it('compacts once the provider reports the context is really that full', async () => {
    const anchor = new ContextAnchorStore()
    // The provider measured this very request at 900 tokens, not the estimated few hundred.
    anchor.record('task', { inputTokens: 900, estimatedAtReport: estimated })
    const t = setup({ window: WINDOW, anchor })
    const result = await t.coordinator.auto('task', request, policy(), undefined, SIGNAL)
    expect(result.attempted).toBe(true)
    expect(result.compacted?.summary).toBe(SUMMARY)
  })
})

describe('CompactionCoordinator settings', () => {
  const ai = (compaction: Record<string, unknown>, autoCompact?: boolean) => ({ ai: { ...(autoCompact === undefined ? {} : { autoCompact }), compaction } })

  it('follows the threshold from Settings: 90 percent full is not yet due at 95, and is due at 85', async () => {
    const t = setup({ window: WINDOW, settings: ai({ threshold: 0.95 }) })
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    const lower = setup({ window: WINDOW, settings: ai({ threshold: 0.85 }) })
    expect(await lower.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toMatchObject({ attempted: true })
  })

  it('measures against the input budget, so a large output cap summarizes earlier than the raw window would', async () => {
    // About 9 600 tokens in a 20 000 window: 48 percent of it, but 96 percent of the 9 952 left once 8 000 are
    // reserved for the answer (and 2 048 for framing the estimate cannot see).
    const request = sized(30_000)
    const reserved = setup({ window: { contextWindow: 20_000 } })
    expect(await reserved.coordinator.auto('task', request, policy('chat-model', 8_000), undefined, SIGNAL)).toMatchObject({ attempted: true })
    const open = setup({ window: { contextWindow: 20_000 } })
    expect(await open.coordinator.auto('task', request, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
  })
})

describe('CompactionCoordinator progress', () => {
  it('reports started once a boundary is chosen, then completed with the numbers, in that order', async () => {
    const t = setup({ window: WINDOW })
    const order: string[] = []
    const seen: CompactionEvent[] = []
    t.send.mockImplementationOnce(async () => { order.push('send'); return response() })
    await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL, (event) => { order.push(`${event.step}:${event.phase}`); seen.push(event) })
    expect(order).toEqual(['summarize:started', 'send', 'summarize:completed'])
    expect(seen[0]).toEqual({ step: 'summarize', phase: 'started', messagesSummarized: 8 })
    expect(seen[1]).toMatchObject({ step: 'summarize', phase: 'completed', summary: SUMMARY, boundaryMessageId: 'u5', messagesSummarized: 8 })
    expect(seen[1]!.tokensBefore).toBeGreaterThan(0)
    expect(seen[1]!.tokensAfter).toBeGreaterThan(0)
  })
})

describe('CompactionCoordinator.prune', () => {
  const user = (text: string): AIMessage => ({ role: 'user', content: [{ type: 'text', text }] })
  const read = (id: string, text: string): AIMessage[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: id } }] },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: id, content: [{ type: 'text', text }] }] }
  ]
  /** Ten reads of about 8 000 tokens each: 80 000 tokens of tool output after one question. */
  const reads = (): AIRequest => ({
    model: 'm',
    messages: [user('Read everything'), ...Array.from({ length: 10 }, (_, index) => read(`t${index + 1}`, `file ${index + 1}\n${'x'.repeat(25_000)}`)).flat()]
  })
  const resultOf = (message: AIMessage): string => {
    const part = message.content[0]
    return part?.type === 'tool_result' && part.content[0]?.type === 'text' ? part.content[0].text : ''
  }
  const FILLED = { contextWindow: 120_000 }

  it('replaces old tool output with stubs once the request is past the start of the ladder, and says how much', () => {
    const t = setup({ window: FILLED })
    const request = reads()
    const outcome = t.coordinator.prune('task', request, policy(), undefined)!
    expect(outcome.event.step).toBe('prune')
    expect(outcome.event.phase).toBe('completed')
    expect(outcome.event.resultsTrimmed).toBeGreaterThan(0)
    expect(outcome.event.tokensFreed).toBeGreaterThan(20_000)
    expect(outcome.messages).toHaveLength(request.messages.length)
    expect(resultOf(outcome.messages[2]!)).toMatch(/^\[Pruned tool output:/)
    expect(resultOf(outcome.messages.at(-1)!)).toContain('file 10')
  })

  it('never throws: a failure is logged and the request goes on unchanged', () => {
    const warn = vi.fn()
    const broken = new CompactionCoordinator({
      repo: { get: () => null, update: () => undefined },
      send: async () => response(),
      modelInfo: () => { throw new Error('catalog unavailable') },
      isRunning: () => false,
      settings: () => undefined,
      loadHistory: () => [],
      warn
    })
    expect(broken.prune('task', reads(), policy(), undefined)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog unavailable'))
  })
})
