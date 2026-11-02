import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY, NormalizedAIError } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest, CompactionEvent, Conversation, StoredMessage } from '@shared/ipc'
import type { HookPayload } from './hooks'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  workspace: '',
  conversation: undefined as unknown as Conversation | undefined,
  updates: [] as Array<Partial<Conversation>>,
  hooked: [] as HookPayload[]
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
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], ai: { autoCompact: true } }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('./hooks', () => ({
  runHooks: async (_hooks: unknown, payload: HookPayload) => { mocks.hooked.push(payload); return { block: false } }
}))

import { ChatService } from './ChatService'

const SUMMARY = 'Goal: ship the parser.\n- Chose a hand-written lexer in src/parser/lexer.ts.\n- npm test passes.'
const policy = { primary: { providerId: 'primary', model: 'first' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }

let root: string
let services: ChatService[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-recovery-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
  writeFileSync(join(mocks.workspace, 'a.ts'), 'export const a = 1\n')
  mocks.updates = []
  mocks.hooked = []
  mocks.conversation = undefined
})
afterEach(() => {
  for (const service of services.splice(0)) { service.cancelAll(); service.dispose() }
  rmSync(root, { recursive: true, force: true })
})

const message = (id: string, role: StoredMessage['role'], text: string): StoredMessage => ({ id, role, text, createdAt: 1 })
function turns(count: number, size = 200): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => [
    message(`u${index + 1}`, 'user', `Question ${index + 1} ${'q'.repeat(size)}`),
    message(`a${index + 1}`, 'assistant', `Answer ${index + 1} ${'a'.repeat(size)}`)
  ]).flat()
}
function conversation(messages: StoredMessage[]): Conversation {
  return { id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages, providerId: 'primary', model: 'first', workspacePath: mocks.workspace }
}
function summaryResponse(text = SUMMARY): AIResponse {
  return { id: 's', provider: 'primary', model: 'first', content: [{ type: 'text', text }], text, toolCalls: [], stopReason: 'stop', createdAt: 1, usage: { inputTokens: 900, outputTokens: 120 } }
}
const overflow = (): NormalizedAIError => new NormalizedAIError({
  provider: 'primary', category: 'INVALID_REQUEST', classification: 'permanent', retryable: false,
  message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens."
})
const textOf = (req: AIRequest): string[] => req.messages.map((item) => (item.content[0]?.type === 'text' ? item.content[0].text : ''))

interface Harness { service: ChatService; events: ChatEvent[]; streams: AIRequest[]; sends: AIRequest[] }
function harness(stream: (request: AIRequest, index: number) => AsyncGenerator<AIStreamEvent>, summary?: () => Promise<AIResponse>): Harness {
  const events: ChatEvent[] = []
  const streams: AIRequest[] = []
  const sends: AIRequest[] = []
  const primary = {
    id: 'primary',
    streamMessage: async function* (req: AIRequest): AsyncGenerator<AIStreamEvent> {
      streams.push(structuredClone(req))
      yield* stream(req, streams.length - 1)
    },
    sendMessage: async (req: AIRequest): Promise<AIResponse> => {
      sends.push(structuredClone(req))
      return summary ? summary() : summaryResponse()
    }
  } as unknown as AIProvider
  const manager = { resolve: (id: string) => (id === 'primary' ? primary : undefined), getModelInfo: () => undefined } as unknown as ProviderManager
  const service = new ChatService(manager, (event) => { events.push(event) })
  services.push(service)
  return { service, events, streams, sends }
}
function request(overrides: Partial<ChatStartRequest> = {}): ChatStartRequest {
  return { streamId: 'stream-owner', conversationId: 'task', messageId: 'u-now', userText: 'Inspect this task', policy, ...overrides }
}
async function finished(events: ChatEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && (event.event.type === 'completed' || event.event.type === 'error'))).toBe(true), { timeout: 5_000 })
}
const progressOf = (events: ChatEvent[]): CompactionEvent[] => events.flatMap((event) => (event.kind === 'compaction' ? [event.compaction] : []))
const errorsOf = (events: ChatEvent[]) => events.flatMap((event) => (event.kind === 'stream' && event.event.type === 'error' ? [event.event.error] : []))

describe('context overflow recovery', () => {
  it('summarizes older turns after the provider says the request is too large, and sends it once more', async () => {
    mocks.conversation = conversation(turns(6))
    const h = harness(async function* (_req, index) {
      if (index === 0) throw overflow()
      yield { type: 'text_delta', text: 'Done.' }
    })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(2)
    expect(h.sends).toHaveLength(1)
    expect(errorsOf(h.events)).toEqual([])
    // The retry carries the summary and fewer messages than the request that failed.
    expect(textOf(h.streams[1]!)[0]).toContain(SUMMARY)
    expect(h.streams[1]!.messages.length).toBeLessThan(h.streams[0]!.messages.length)
    expect(h.events.filter((event) => event.kind === 'compacted')).toHaveLength(1)
    expect(progressOf(h.events).map((e) => `${e.step}:${e.phase}`)).toEqual(['summarize:started', 'summarize:completed'])
    expect(h.events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true)
    // The compaction hooks ran around it with the overflow trigger.
    await vi.waitFor(() => expect(mocks.hooked.filter((p) => p.event === 'PostCompact')).toHaveLength(1))
    expect(mocks.hooked.filter((p) => p.event === 'PreCompact' || p.event === 'PostCompact')).toMatchObject([
      { event: 'PreCompact', trigger: 'overflow' }, { event: 'PostCompact', trigger: 'overflow', summary: expect.stringContaining('Goal: ship the parser.') }
    ])
  })

  it('stubs old tool output first', async () => {
    mocks.conversation = conversation(turns(6))
    const big = Array.from({ length: 800 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n')
    const h = harness(async function* (_req, index) {
      if (index === 0) {
        yield { type: 'tool_call', toolCall: { id: 'r1', name: 'read_file', input: { path: 'a.ts' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else if (index === 1) {
        yield { type: 'tool_call', toolCall: { id: 'r2', name: 'read_file', input: { path: 'c.ts' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else if (index === 2) {
        yield { type: 'tool_call', toolCall: { id: 'r3', name: 'list_files', input: { path: '.' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else if (index === 3) {
        throw overflow()
      } else yield { type: 'text_delta', text: 'Done.' }
    })
    writeFileSync(join(mocks.workspace, 'a.ts'), big)
    writeFileSync(join(mocks.workspace, 'c.ts'), big)
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events)
    expect(h.streams).toHaveLength(5)
    expect(JSON.stringify(h.streams[3]!.messages)).not.toContain('[Pruned tool output')
    expect(JSON.stringify(h.streams[4]!.messages)).toContain('[Pruned tool output')
    expect(progressOf(h.events).some((e) => e.step === 'prune' && e.phase === 'completed')).toBe(true)
  })

  it('retries at most once per request and ends with the context-length error', async () => {
    mocks.conversation = conversation(turns(6))
    const h = harness(async function* () { throw overflow() })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(2)
    expect(h.sends).toHaveLength(1)
    const errors = errorsOf(h.events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ category: 'CONTEXT_LENGTH' })
  })

  it('ends the turn when there is nothing to summarize, without a second request', async () => {
    mocks.conversation = conversation(turns(1))
    const h = harness(async function* () { throw overflow() })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(h.sends).toHaveLength(0)
    expect(errorsOf(h.events)).toMatchObject([{ category: 'CONTEXT_LENGTH' }])
  })

  it('ends the turn when the summary fails', async () => {
    mocks.conversation = conversation(turns(6))
    const h = harness(async function* () { throw overflow() }, async () => { throw new Error('summary down') })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(errorsOf(h.events)).toMatchObject([{ category: 'CONTEXT_LENGTH' }])
    expect(progressOf(h.events).map((e) => `${e.step}:${e.phase}`)).toEqual(['summarize:started', 'summarize:failed'])
  })

  it('does not treat other errors as an overflow', async () => {
    mocks.conversation = conversation(turns(6))
    const h = harness(async function* () {
      throw new NormalizedAIError({ provider: 'primary', category: 'RATE_LIMIT_ERROR', classification: 'transient', retryable: false, message: 'Rate limit: too many tokens per minute' })
    })
    await h.service.start(request())
    await finished(h.events)
    expect(h.streams).toHaveLength(1)
    expect(h.sends).toHaveLength(0)
    expect(errorsOf(h.events)).toMatchObject([{ category: 'RATE_LIMIT_ERROR' }])
  })
})

describe('the working set after a summary', () => {
  it('ends a manual summary with the todo list and the files the agent read and edited', async () => {
    mocks.conversation = conversation(turns(5, 40))
    const h = harness(async function* (_req, index): AsyncGenerator<AIStreamEvent> {
      if (index === 0) {
        yield { type: 'tool_call', toolCall: { id: 't1', name: 'todo_write', input: { todos: [{ content: 'Add the lexer', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }] } } }
        yield { type: 'tool_call', toolCall: { id: 'r1', name: 'read_file', input: { path: 'a.ts' } } }
        yield { type: 'tool_call', toolCall: { id: 'w1', name: 'write_file', input: { path: 'b.ts', content: 'export const b = 2\n' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Done.' }
    })
    await h.service.start(request({ fileToolsEnabled: true, permissionMode: 'bypass' }))
    await finished(h.events)
    await vi.waitFor(() => expect(h.service.compactConversation('task')).resolves.toMatchObject({ ok: true }))
    const stored = mocks.updates.at(-1)!.contextSummary!
    expect(stored.startsWith(SUMMARY)).toBe(true)
    expect(stored).toContain('Working set')
    expect(stored).toContain('[in progress] Add the lexer')
    expect(stored).toContain('Files edited: b.ts')
    expect(stored).toContain('Files read: a.ts')
    expect(stored.length - SUMMARY.length).toBeLessThan(1_600)
    // It survives later turns: the stored summary is what every request starts with.
    await vi.waitFor(() => expect(h.service.compactConversation('task')).resolves.toMatchObject({ ok: false }))
    // And the compaction hooks ran around the manual summary.
    expect(mocks.hooked.filter((p) => p.event === 'PreCompact' || p.event === 'PostCompact').map((p) => `${p.event}:${p.trigger}`)).toEqual(['PreCompact:manual', 'PostCompact:manual'])
  })

  it('adds no note when the agent has done nothing', async () => {
    mocks.conversation = conversation(turns(5, 40))
    const h = harness(async function* () { yield { type: 'text_delta', text: 'Done.' } })
    await expect(h.service.compactConversation('task')).resolves.toMatchObject({ ok: true, summary: SUMMARY })
  })
})

describe('repeat-call detection', () => {
  const sameCall = (index: number): AIStreamEvent[] => [
    { type: 'tool_call', toolCall: { id: `r${index}`, name: 'read_file', input: { path: 'a.ts' } } },
    { type: 'stop', stopReason: 'tool_use' }
  ]

  it('notes the third identical call and stops the turn on the fifth', async () => {
    mocks.conversation = conversation([])
    const h = harness(async function* (_req, index) { yield* sameCall(index) })
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events)
    expect(h.streams).toHaveLength(5)
    const resultText = (req: AIRequest, id: string): string => JSON.stringify(req.messages.flatMap((m) => m.content).filter((p) => p.type === 'tool_result' && p.toolUseId === id))
    // Request 4 carries the result of call 3, with the note; calls 1 and 2 have none.
    expect(resultText(h.streams[3]!, 'r1')).toContain('export const a')
    expect(resultText(h.streams[3]!, 'r0')).not.toContain('identical input')
    expect(resultText(h.streams[3]!, 'r1')).not.toContain('identical input')
    expect(resultText(h.streams[3]!, 'r2')).toContain('same read_file call with identical input, made 3 times in a row')
    const text = h.events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'text_delta' ? [e.event.text] : [])).join('')
    expect(text).toContain('Stopped: the agent made the same read_file call 5 times.')
    expect(h.events.some((e) => e.kind === 'stream' && e.event.type === 'completed')).toBe(true)
  })

  it('does not stop a turn whose calls differ', async () => {
    mocks.conversation = conversation([])
    const h = harness(async function* (_req, index) {
      if (index < 6) {
        yield { type: 'tool_call', toolCall: { id: `r${index}`, name: 'read_file', input: { path: 'a.ts', offset: index } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'All done.' }
    })
    await h.service.start(request({ fileToolsEnabled: true }))
    await finished(h.events)
    expect(h.streams).toHaveLength(7)
    const text = h.events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'text_delta' ? [e.event.text] : [])).join('')
    expect(text).not.toContain('Stopped:')
  })
})
