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

  it('prefers the routing of the latest turn, until the task is forgotten', async () => {
    const t = setup()
    t.coordinator.rememberPolicy('task', policy('chat-model'))
    await t.coordinator.compact('task')
    expect(t.send.mock.calls[0]![1].primary.model).toBe('chat-model')
    t.coordinator.forget('task')
    t.set({ ...t.current()!, contextStartMessageId: undefined, contextSummary: undefined })
    await t.coordinator.compact('task')
    expect(t.send.mock.calls[1]![1].primary.model).toBe('stored-model')
  })

  it('takes retry and timeout settings for a stored model from the app settings', async () => {
    const t = setup({ settings: { ai: { retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }, timeout: { requestMs: 5_000 } } } })
    await t.coordinator.compact('task')
    expect(t.send.mock.calls[0]![1]).toMatchObject({ retry: { maxAttempts: 1 }, timeout: { requestMs: 5_000 } })
    const bare = setup({ settings: undefined })
    bare.coordinator.compact('task')
    await vi.waitFor(() => expect(bare.send).toHaveBeenCalled())
    expect(bare.send.mock.calls[0]![1].timeout).toEqual({})
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

  it('is refused while a turn runs, for an unknown task, and without any model', async () => {
    expect(await setup({ running: true }).coordinator.compact('task')).toEqual({ ok: false, error: expect.stringMatching(/running/i) })
    expect(await setup({ conversation: null }).coordinator.compact('task')).toEqual({ ok: false, error: 'Conversation not found.' })
    const noModel = setup({ conversation: { providerId: undefined, model: undefined } })
    expect(await noModel.coordinator.compact('task')).toEqual({ ok: false, error: expect.stringMatching(/model/i) })
    expect(noModel.send).not.toHaveBeenCalled()
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

  it('does not read the stored task until the request is large enough to matter', async () => {
    const t = setup({ window: WINDOW })
    expect(await t.coordinator.auto('task', sized(100), policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    expect(t.get).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })

  it.each([
    ['the setting is off', { window: WINDOW, settings: { ai: { autoCompact: false } } }, 6],
    ['the window is unknown', {}, 6],
    ['the window is unusable', { window: { contextWindow: 0 } }, 6],
    ['there are fewer than three user turns', { window: WINDOW }, 2]
  ])('does nothing when %s', async (_name, options, turnCount) => {
    const t = setup({ ...options, conversation: { messages: turns(turnCount) } })
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    expect(t.send).not.toHaveBeenCalled()
    expect(t.update).not.toHaveBeenCalled()
  })

  it('treats the gated long-context window as 200k unless the request opted in', async () => {
    const window = { contextWindow: 1_000_000, longContextBeta: true }
    // 700k characters is about 175k tokens: 87 percent of 200k, 17 percent of 1M.
    const big = sized(700_000)
    const gated = setup({ window })
    expect(await gated.coordinator.auto('task', big, policy(), undefined, SIGNAL)).toMatchObject({ attempted: true })
    const open = setup({ window })
    expect(await open.coordinator.auto('task', big, policy(), { 'x-cubex-long-context': '1' }, SIGNAL)).toEqual({ attempted: false })
    expect(open.send).not.toHaveBeenCalled()
  })

  it('forwards the long-context header to the summary call', async () => {
    const t = setup({ window: { contextWindow: 1_000_000, longContextBeta: true } })
    await t.coordinator.auto('task', sized(4_000_000), policy(), { 'x-cubex-long-context': '1' }, SIGNAL)
    expect(t.send.mock.calls[0]![2]?.headers).toEqual({ 'x-cubex-long-context': '1' })
  })

  it('reports a failed summary as attempted, without a result, and says why', async () => {
    const t = setup({ window: WINDOW })
    t.send.mockRejectedValueOnce(new Error('Provider unavailable'))
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: true })
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('Provider unavailable'))
    expect(t.update).not.toHaveBeenCalled()
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

  it('drops the anchor after compacting, so the next turn is not judged on a dead conversation', async () => {
    const anchor = new ContextAnchorStore()
    anchor.record('task', { inputTokens: 900, estimatedAtReport: estimated })
    const t = setup({ window: WINDOW, anchor })
    await t.coordinator.auto('task', request, policy(), undefined, SIGNAL)
    expect(anchor.get('task')).toBeUndefined()
  })

  it('forgets the anchor with the task', () => {
    const anchor = new ContextAnchorStore()
    anchor.record('task', { inputTokens: 900, estimatedAtReport: estimated })
    setup({ window: WINDOW, anchor }).coordinator.forget('task')
    expect(anchor.get('task')).toBeUndefined()
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

  it('reads Settings on every call, so a change applies to the next request without a restart', async () => {
    const options = { window: WINDOW, settings: ai({ threshold: 0.95 }) }
    const t = setup(options)
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    options.settings = ai({ threshold: 0.5 })
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toMatchObject({ attempted: true })
  })

  it('lets ai.compaction.auto win over the older ai.autoCompact in both directions', async () => {
    const off = setup({ window: WINDOW, settings: ai({ auto: false }, true) })
    expect(await off.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
    const on = setup({ window: WINDOW, settings: ai({ auto: true }, false) })
    expect(await on.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toMatchObject({ attempted: true })
  })

  it('falls back to the older switch when ai.compaction has no auto', async () => {
    const off = setup({ window: WINDOW, settings: ai({ threshold: 0.6 }, false) })
    expect(await off.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL)).toEqual({ attempted: false })
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

  it('bills a manual summary to the task', async () => {
    const t = setup({ settings: ai({ threshold: 0.7 }) })
    await t.coordinator.compact('task')
    expect(t.send.mock.calls[0]![2]?.conversationId).toBe('task')
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

  it('reports a failure only for a summary that began, with the reason', async () => {
    const t = setup({ window: WINDOW })
    t.send.mockRejectedValueOnce(new Error('Provider unavailable'))
    const events: CompactionEvent[] = []
    expect(await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, SIGNAL, (event) => events.push(event))).toEqual({ attempted: true })
    expect(events).toEqual([
      { step: 'summarize', phase: 'started', messagesSummarized: 8 },
      { step: 'summarize', phase: 'failed', error: expect.stringContaining('Provider unavailable') }
    ])
  })

  it('says nothing when the request is not due', async () => {
    const t = setup({ window: WINDOW })
    const events: CompactionEvent[] = []
    await t.coordinator.auto('task', sized(100), policy(), undefined, SIGNAL, (event) => events.push(event))
    expect(events).toEqual([])
  })

  it('reports a cancelled summary as a failure the person can read', async () => {
    const t = setup({ window: WINDOW })
    const controller = new AbortController()
    t.send.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted') })
    const events: CompactionEvent[] = []
    await t.coordinator.auto('task', NEARLY_FULL, policy(), undefined, controller.signal, (event) => events.push(event))
    expect(events.at(-1)).toEqual({ step: 'summarize', phase: 'failed', error: 'Compaction was cancelled.' })
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

  it('leaves the request alone below 60 percent of the budget', () => {
    const t = setup({ window: { contextWindow: 400_000 } })
    expect(t.coordinator.prune('task', reads(), policy(), undefined)).toBeUndefined()
  })

  it('starts earlier when the summarizing threshold is lowered, because pruning keeps ten points below it', () => {
    // 80 000 tokens is about 53 percent of 150 000: below 60 percent, above the 40 percent that a 0.5 threshold gives.
    const defaults = setup({ window: { contextWindow: 150_000 } })
    expect(defaults.coordinator.prune('task', reads(), policy(), undefined)).toBeUndefined()
    const lowered = setup({ window: { contextWindow: 150_000 }, settings: { ai: { compaction: { threshold: 0.5 } } } })
    expect(lowered.coordinator.prune('task', reads(), policy(), undefined)).toBeDefined()
  })

  it('does nothing when pruning is switched off, the window is unknown, or there is no old output', () => {
    expect(setup({ window: FILLED, settings: { ai: { compaction: { prune: false } } } }).coordinator.prune('task', reads(), policy(), undefined)).toBeUndefined()
    expect(setup({}).coordinator.prune('task', reads(), policy(), undefined)).toBeUndefined()
    expect(setup({ window: FILLED }).coordinator.prune('task', { model: 'm', messages: [user('hi')] }, policy(), undefined)).toBeUndefined()
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
