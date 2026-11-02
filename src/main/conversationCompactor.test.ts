import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_POLICY, NormalizedAIError } from '@core/types'
import type { AIRequest, AIResponse, RoutingPolicy } from '@core/types'
import type { Conversation, StoredMessage } from '@shared/ipc'
import { compactConversation, type CompactorDeps } from './conversationCompactor'

const message = (id: string, role: StoredMessage['role'], text: string): StoredMessage => ({ id, role, text, createdAt: 1 })
/** u1 a1 u2 a2 ... */
function transcript(turns: number, size = 20): StoredMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    message(`u${index + 1}`, 'user', `Question ${index + 1} ${'q'.repeat(size)}`),
    message(`a${index + 1}`, 'assistant', `Answer ${index + 1} ${'a'.repeat(size)}`)
  ]).flat()
}
const summaryText = 'Goal: ship the parser.\n- Chose a hand-written lexer in src/parser/lexer.ts.\n- npm test passes.'
const response = (text: string, stopReason: AIResponse['stopReason'] = 'stop'): AIResponse =>
  ({ id: 'r', provider: 'p', model: 'm', content: [{ type: 'text', text }], text, toolCalls: [], stopReason, createdAt: 1 })
const policy = (overrides: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  primary: { providerId: 'p', model: 'writer', params: { maxOutputTokens: 8192, reasoningEffort: 'high', temperature: 0.7 } },
  fallbacks: [{ providerId: 'other', model: 'backup' }], fallbackEnabled: true,
  retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 }, timeout: { requestMs: 60_000 }, ...overrides
})

function setup(conversation: Partial<Conversation> | null, reply: () => Promise<AIResponse> = async () => response(summaryText)) {
  let stored: Conversation | null = conversation && {
    id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages: transcript(5), ...conversation
  }
  const sent: Array<{ request: AIRequest; policy: RoutingPolicy; options?: { signal?: AbortSignal; headers?: Record<string, string>; conversationId?: string } }> = []
  const update = vi.fn((_id: string, patch: Partial<Conversation>) => { if (stored) stored = { ...stored, ...patch } })
  const deps: CompactorDeps = {
    repo: { get: () => (stored ? structuredClone(stored) : null), update },
    send: async (request, routing, options) => { sent.push({ request: structuredClone(request), policy: routing, options }); return reply() },
    now: () => 1_700_000_000_000
  }
  return { deps, sent, update, current: () => stored, replace: (next: Conversation | null) => { stored = next } }
}
const promptOf = (request: AIRequest): string => {
  const part = request.messages[0]!.content[0]!
  return part.type === 'text' ? part.text : ''
}

describe('compactConversation', () => {
  it('summarizes everything before the last two turns and stores the summary with its boundary', async () => {
    const t = setup({})
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    expect(result).toMatchObject({ ok: true, summary: summaryText, boundaryMessageId: 'u4' })
    expect(t.update).toHaveBeenCalledTimes(1)
    expect(t.update).toHaveBeenCalledWith('task', { contextStartMessageId: 'u4', contextSummary: summaryText, contextSummaryAt: 1_700_000_000_000 })
    const prompt = promptOf(t.sent[0]!.request)
    expect(prompt).toContain('Question 1 ')
    expect(prompt).toContain('Answer 3 ')
    expect(prompt).not.toContain('Question 4 ')
    // The transcript itself is never touched.
    expect(t.current()!.messages).toEqual(transcript(5))
  })

  it('folds an earlier summary in and only re-reads the turns after the old boundary', async () => {
    const t = setup({ messages: transcript(6), contextStartMessageId: 'u3', contextSummary: 'OLD SUMMARY: chose Postgres.' })
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    expect(result).toMatchObject({ ok: true, boundaryMessageId: 'u5' })
    const prompt = promptOf(t.sent[0]!.request)
    expect(prompt.match(/<previous_summary>/g)).toHaveLength(1)
    expect(prompt).toContain('OLD SUMMARY: chose Postgres.')
    expect(prompt).toContain('Question 3 ')
    expect(prompt).toContain('Answer 4 ')
    expect(prompt).not.toContain('Question 2 ')
    expect(prompt).not.toContain('Question 5 ')
    expect(t.current()).toMatchObject({ contextStartMessageId: 'u5', contextSummary: summaryText })
  })

  it('ignores a summary whose boundary no longer exists and summarizes the full history', async () => {
    const t = setup({ contextStartMessageId: 'deleted', contextSummary: 'STALE SUMMARY' })
    await compactConversation(t.deps, 'task', { policy: policy() })
    const prompt = promptOf(t.sent[0]!.request)
    expect(prompt).not.toContain('STALE SUMMARY')
    expect(prompt).toContain('Question 1 ')
  })

  it.each([0, 1, 2])('says there is nothing to compact with %i turns and makes no model call', async (turns) => {
    const t = setup({ messages: transcript(turns) })
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not enough/i) })
    expect(t.sent).toHaveLength(0)
    expect(t.update).not.toHaveBeenCalled()
  })

  it('leaves the conversation untouched when the summary call fails', async () => {
    const t = setup({}, async () => { throw new NormalizedAIError({ provider: 'p', category: 'RATE_LIMIT_ERROR', classification: 'transient', retryable: true, message: 'Rate limited' }) })
    const before = structuredClone(t.current())
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Rate limited') })
    expect(t.update).not.toHaveBeenCalled()
    expect(t.current()).toEqual(before)
  })

  it.each(['', '   ', '```\n```', 'Done.'])('rejects an empty or unusably short summary (%j)', async (text) => {
    const t = setup({}, async () => response(text))
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/empty|too short/i) })
    expect(t.update).not.toHaveBeenCalled()
  })

  it('stores nothing when it was cancelled before or during the call', async () => {
    const early = setup({})
    const controller = new AbortController()
    controller.abort()
    expect(await compactConversation(early.deps, 'task', { policy: policy(), signal: controller.signal })).toEqual({ ok: false, error: expect.stringMatching(/cancel/i) })
    expect(early.sent).toHaveLength(0)

    const during = new AbortController()
    const late = setup({}, async () => { during.abort(); return response(summaryText) })
    expect(await compactConversation(late.deps, 'task', { policy: policy(), signal: during.signal })).toEqual({ ok: false, error: expect.stringMatching(/cancel/i) })
    expect(late.update).not.toHaveBeenCalled()
  })

  it('does not overwrite a conversation that was compacted, cleared or rewound while the model was working', async () => {
    const compactedMeanwhile = setup({}, async () => {
      compactedMeanwhile.replace({ ...compactedMeanwhile.current()!, contextStartMessageId: 'u2', contextSummary: 'OTHER' })
      return response(summaryText)
    })
    expect(await compactConversation(compactedMeanwhile.deps, 'task', { policy: policy() })).toEqual({ ok: false, error: expect.stringMatching(/changed/i) })
    expect(compactedMeanwhile.update).not.toHaveBeenCalled()

    const rewound = setup({}, async () => {
      rewound.replace({ ...rewound.current()!, messages: transcript(5).slice(0, 4) })
      return response(summaryText)
    })
    expect(await compactConversation(rewound.deps, 'task', { policy: policy() })).toEqual({ ok: false, error: expect.stringMatching(/changed/i) })
    expect(rewound.update).not.toHaveBeenCalled()

    const deleted = setup({}, async () => { deleted.replace(null); return response(summaryText) })
    expect(await compactConversation(deleted.deps, 'task', { policy: policy() })).toMatchObject({ ok: false })
  })

  it('keeps fewer turns when the request is nearly full of large ones, and sizes the prompt to the model window', async () => {
    const t = setup({ messages: transcript(6, 44_000) })
    const result = await compactConversation(t.deps, 'task', { policy: policy(), contextWindow: 8_000, estimatedTokens: 7_500 })
    expect(result).toMatchObject({ ok: true, boundaryMessageId: 'u6' })
    // An 8k window cannot hold the transcript: long items are trimmed and middle turns dropped.
    const prompt = promptOf(t.sent[0]!.request)
    expect(prompt).toMatch(/chars trimmed/)
    expect(prompt).toMatch(/omitted from the middle/)
    expect(prompt.length).toBeLessThan(12_000)
  })
})

describe('what the summary reports', () => {
  it('counts every message before the new boundary and compares the replaced tokens with the summary', async () => {
    const t = setup({ messages: transcript(5, 400) })
    const result = await compactConversation(t.deps, 'task', { policy: policy() })
    if (!result.ok) throw new Error(result.error)
    // u1 a1 u2 a2 u3 a3 sit before the boundary u4.
    expect(result.messagesSummarized).toBe(6)
    expect(result.tokensBefore).toBeGreaterThan(500)
    expect(result.tokensAfter).toBeGreaterThan(0)
    expect(result.tokensAfter!).toBeLessThan(result.tokensBefore!)
  })
})
