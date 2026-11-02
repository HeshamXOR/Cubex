import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_RETRY_POLICY, NormalizedAIError } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ModelInfo } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: [] }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let service: ChatService | undefined
let fixtureRoot: string
beforeEach(() => {
  const output = resolve('out')
  mkdirSync(output, { recursive: true })
  fixtureRoot = mkdtempSync(join(output, 'cubex-limit-test-'))
  mocks.dataRoot = join(fixtureRoot, 'data')
  mocks.workspace = join(fixtureRoot, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function request(overrides: Partial<ChatStartRequest> = {}, maxOutputTokens?: number): ChatStartRequest {
  return {
    streamId: 'stream-one', conversationId: 'task-one', messageId: 'user-one', userText: 'Write the page.',
    fileToolsEnabled: true, permissionMode: 'bypass',
    policy: {
      primary: { providerId: 'primary', model: 'test', ...(maxOutputTokens !== undefined ? { params: { maxOutputTokens } } : {}) },
      fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {}
    },
    ...overrides
  }
}

function startService(stream: (request: AIRequest) => AsyncGenerator<AIStreamEvent>, events: ChatEvent[], info?: Partial<ModelInfo>): ChatService {
  const provider = { id: 'primary', streamMessage: stream } as unknown as AIProvider
  const manager = {
    resolve: (id: string) => id === 'primary' ? provider : undefined,
    getModelInfo: () => info as ModelInfo | undefined
  } as unknown as ProviderManager
  service = new ChatService(manager, (event) => { events.push(event) })
  return service
}

async function finished(events: ChatEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 5_000 })
}

const completedText = (events: ChatEvent[]): string => {
  const done = events.find((e) => e.kind === 'stream' && e.event.type === 'completed')
  return done && done.kind === 'stream' && done.event.type === 'completed' ? done.event.response.text : ''
}

/** What the provider sees for a model that was cut off while writing write_file's arguments. */
async function* cutInsideToolCall(preface = 'Writing the page.'): AsyncGenerator<AIStreamEvent> {
  if (preface) yield { type: 'text_delta', text: preface }
  yield { type: 'tool_call_delta', index: 0, id: 'toolu_cut', name: 'write_file' }
  yield { type: 'tool_call_delta', index: 0, argsDelta: '{"path":"page.html","content":"<html><body>' }
  yield { type: 'usage', usage: { inputTokens: 14_000, outputTokens: 32_000 } }
  yield { type: 'stop', stopReason: 'length' }
}

async function* wholeCall(): AsyncGenerator<AIStreamEvent> {
  yield { type: 'tool_call_delta', index: 0, id: 'toolu_ok', name: 'write_file' }
  yield { type: 'tool_call_delta', index: 0, argsDelta: '{"path":"page.html","content":"<html></html>"}' }
  yield { type: 'stop', stopReason: 'tool_use' }
}

describe('the answer limit a turn is sent with', () => {
  it('is the automatic size when nothing was chosen, and never the old 4,096', async () => {
    const events: ChatEvent[] = []
    const seen: Array<number | undefined> = []
    const chat = startService(async function* (req) { seen.push(req.params?.maxOutputTokens); yield { type: 'text_delta', text: 'ok' } }, events)
    await chat.start(request())
    await finished(events)
    expect(seen).toEqual([32_000])
  })

  it('tries once more with the limit a provider names when it refuses ours, and remembers it', async () => {
    const events: ChatEvent[] = []
    const seen: Array<number | undefined> = []
    const chat = startService(async function* (req) {
      seen.push(req.params?.maxOutputTokens)
      if (req.params?.maxOutputTokens === 32_000) {
        throw new NormalizedAIError({
          provider: 'primary', category: 'INVALID_REQUEST', classification: 'permanent', retryable: false, statusCode: 400,
          message: 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for test'
        })
      }
      yield { type: 'text_delta', text: 'ok' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(seen).toEqual([32_000, 8_192])
    expect(events.filter((e) => e.kind === 'stream' && e.event.type === 'error')).toEqual([])
    expect(completedText(events)).toBe('ok')

    // The next turn on this model begins at what it allows.
    await chat.start(request({ streamId: 'stream-two', conversationId: 'task-two' }))
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'stream' && e.event.type === 'completed')).toHaveLength(2), { timeout: 5_000 })
    expect(seen.slice(2)).toEqual([8_192])
  })
})

describe('a reply cut off by the output limit', () => {
  it('runs nothing from a tool call it left half written, tells the model, and gives an automatic limit more room', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req) {
      requests.push(structuredClone(req))
      if (requests.length === 1) yield* cutInsideToolCall()
      else if (requests.length === 2) yield* wholeCall()
      else yield { type: 'text_delta', text: 'Done.' }
    }, events, { maxOutputTokens: 128_000 })
    // The page that was written is an edit no check has run after; saying not to run anything keeps the done check out of this test.
    await chat.start(request({ userText: "Write the page. Don't run anything." }))
    await finished(events)

    expect(requests).toHaveLength(3)
    expect(requests[0]!.params?.maxOutputTokens).toBe(32_000)
    expect(requests[1]!.params?.maxOutputTokens).toBe(64_000)
    // The half call is not in the history; its text and an explanation are.
    const second = requests[1]!.messages
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second[1]!.content).toEqual([{ type: 'text', text: 'Writing the page.' }])
    const note = second[2]!.content[0]
    expect(note).toMatchObject({ type: 'text' })
    expect(note && 'text' in note ? note.text : '').toMatch(/output limit of 32,000 tokens[\s\S]*nothing was run[\s\S]*now 64,000/)
    // The complete call that followed did run.
    expect(existsSync(join(mocks.workspace, 'page.html'))).toBe(true)
  })

  it('stops a turn that keeps being cut, writes nothing, and says why', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req) { requests.push(structuredClone(req)); yield* cutInsideToolCall('') }, events, { maxOutputTokens: 128_000 })
    await chat.start(request())
    await finished(events)
    expect(requests.length).toBeLessThanOrEqual(3)
    expect(existsSync(join(mocks.workspace, 'page.html'))).toBe(false)
    const text = completedText(events)
    expect(text).toMatch(/keep reaching the output limit of 64,000 tokens/)
    expect(events.some((e) => e.kind === 'stream' && e.event.type === 'text_delta' && /keep reaching/.test(e.event.text))).toBe(true)
  })
})

describe('a tool call whose arguments were not valid JSON', () => {
  it('is reported to the model instead of reaching the tool', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req) {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'toolu_bad', name: 'write_file' }
        yield { type: 'tool_call_delta', index: 0, argsDelta: '{"path": page.html' }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Retrying.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(2)
    const result = requests[1]!.messages.at(-1)!.content[0]
    expect(result).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_bad', isError: true })
    expect(JSON.stringify(result)).toMatch(/not valid JSON/)
    expect(existsSync(join(mocks.workspace, 'page.html'))).toBe(false)
    expect(events.some((e) => e.kind === 'tool' && e.tool.name === 'write_file' && e.tool.phase === 'error' && /not valid JSON/.test(e.tool.detail ?? ''))).toBe(true)
  })
})

