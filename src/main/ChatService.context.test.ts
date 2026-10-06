import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY, NormalizedAIError } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ModelInfo } from '@core/types'
import type { ChatEvent, ChatStartRequest, ContextUsageSnapshot, StoredMessage } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', history: [] as StoredMessage[], boundary: undefined as string | undefined }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: () => ({ id: 'task', messages: mocks.history, contextStartMessageId: mocks.boundary }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {}, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let service: ChatService | undefined
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-context-chat-'))
  mocks.history = []
  mocks.boundary = undefined
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

function request(): ChatStartRequest {
  return {
    streamId: 'stream-owner', conversationId: 'task', userText: 'Inspect this task', systemPrompt: 'Preserve public APIs.',
    policy: { primary: { providerId: 'primary', model: 'first', params: { maxOutputTokens: 2048 } }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}
function provider(id: string, stream: (request: AIRequest) => AsyncGenerator<AIStreamEvent>): AIProvider {
  return { id, streamMessage: stream } as unknown as AIProvider
}
function manager(providers: AIProvider[], metadata: Record<string, Partial<ModelInfo>> = {}): ProviderManager {
  return { resolve: (id: string) => providers.find((item) => item.id === id), getModelInfo: (id: string, model: string) => metadata[`${id}/${model}`] } as unknown as ProviderManager
}
function snapshots(events: ChatEvent[]): ContextUsageSnapshot[] {
  return events.filter((event) => event.kind === 'context').map((event) => event.context)
}
async function finished(events: ChatEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
}

describe('ChatService context snapshots', () => {
  it.each(['u2', 'removed-message'])('loads only the selected history while preserving the stored transcript (%s)', async (boundary) => {
    mocks.history = [
      { id: 'u1', role: 'user', text: 'Original request', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'Original response', createdAt: 2 },
      { id: 'u2', role: 'user', text: 'Retained request', createdAt: 3 },
      { id: 'a2', role: 'assistant', text: 'Retained response', createdAt: 4 }
    ]
    mocks.boundary = boundary
    const original = structuredClone(mocks.history)
    const requests: AIRequest[] = []
    const events: ChatEvent[] = []
    const model = provider('primary', async function* (req) {
      requests.push(structuredClone(req))
      yield { type: 'text_delta', text: 'Done.' }
    })
    service = new ChatService(manager([model]), (event) => { events.push(event) })
    await service.start(request())
    await finished(events)
    const expected = (boundary === 'u2' ? original.slice(2) : original).map((message) => message.text)
    expect(requests[0]?.messages.map((message) => message.content[0]?.type === 'text' ? message.content[0].text : '')).toEqual([...expected, 'Inspect this task'])
    expect(mocks.history).toEqual(original)
  })

  it('normalizes new and historical text uploads before accounting and leaves unavailable old files explicit', async () => {
    const file = (filename: string, text: string) => ({ type: 'file' as const, filename, source: { kind: 'base64' as const, mediaType: 'text/plain', data: Buffer.from(text).toString('base64') } })
    mocks.history = [{
      id: 'old-user', role: 'user', text: 'Old attachments', createdAt: 1,
      contentJson: JSON.stringify([
        { type: 'text', text: 'Old attachments' },
        file('prior.ts', 'export const previous = true'),
        { type: 'file', filename: 'old.pdf', source: { kind: 'base64', mediaType: 'application/pdf', data: Buffer.from('%PDF').toString('base64') } }
      ])
    }]
    const original = structuredClone(mocks.history)
    const requests: AIRequest[] = []
    const events: ChatEvent[] = []
    const model = provider('primary', async function* (req) {
      requests.push(structuredClone(req))
      yield { type: 'text_delta', text: 'Done.' }
    })
    service = new ChatService(manager([model]), (event) => { events.push(event) })
    await service.start({ ...request(), attachments: [file('current.ts', 'export const current = true')] })
    await finished(events)
    const parts = requests[0]!.messages.flatMap((message) => message.content)
    expect(parts.some((part) => part.type === 'file')).toBe(false)
    expect(parts.filter((part) => part.type === 'text' && part.attachment).map((part) => part.type === 'text' ? part.attachment?.filename : '')).toEqual(['prior.ts', 'current.ts'])
    expect(JSON.stringify(parts)).toContain('export const previous = true')
    expect(JSON.stringify(parts)).toContain('export const current = true')
    expect(JSON.stringify(parts)).toContain('Previous attachment unavailable')
    expect(mocks.history).toEqual(original)
  })

  it('rejects a new unsupported upload before any model request and releases its stream id', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const model = provider('primary', async function* (req) {
      requests.push(req)
      yield { type: 'text_delta', text: 'Done.' }
    })
    service = new ChatService(manager([model]), (event) => { events.push(event) })
    await expect(service.start({ ...request(), attachments: [{ type: 'file', filename: 'report.pdf', source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERg==' } }] })).rejects.toThrow('report.pdf')
    expect(requests).toHaveLength(0)
    await service.start(request())
    await finished(events)
    expect(requests).toHaveLength(1)
  })

  it('estimates each actual tool-loop request and keeps measured usage local to that request', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const model = provider('primary', async function* (req) {
      expect(snapshots(events).at(-1)?.measuredInputTokens).toBeUndefined()
      requests.push(structuredClone(req))
      yield { type: 'start', provider: 'primary', model: req.model }
      if (requests.length === 1) {
        yield { type: 'tool_call', toolCall: { id: 'todo', name: 'todo_write', input: { todos: [{ content: 'Inspect', status: 'completed' }] } } }
        yield { type: 'usage', usage: { inputTokens: 101, outputTokens: 30 } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', text: 'Done.' }
        yield { type: 'usage', usage: { inputTokens: 205, outputTokens: 5 } }
        yield { type: 'stop', stopReason: 'stop' }
      }
    })
    service = new ChatService(manager([model], { 'primary/first': { contextWindow: 32_000 } }), (event) => { events.push(event) })
    await service.start({ ...request(), fileToolsEnabled: true })
    await finished(events)
    const context = snapshots(events)
    expect(requests).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'context').every((event) => event.streamId === 'stream-owner')).toBe(true)
    expect(context[0]).toMatchObject({ contextWindow: 32_000, outputReserve: 2048, outputReserveKnown: true })
    expect(context[0]?.sections.find((row) => row.id === 'system')?.details?.some((row) => row.id === 'user')).toBe(true)
    expect(context[0]?.sections.find((row) => row.id === 'toolResults')?.count).toBe(0)
    expect(context.at(-1)?.sections.find((row) => row.id === 'toolResults')?.count).toBe(1)
    expect(context.filter((row) => row.measuredInputTokens !== undefined).map((row) => row.measuredInputTokens)).toEqual([101, 205])
    expect(context.at(-1)?.estimatedTokens).toBeGreaterThan(context[0]!.estimatedTokens)
    expect(requests.every((req) => req.params?.maxOutputTokens === 2048)).toBe(true)
  })

  it('uses fallback model metadata and output params when the gateway changes targets', async () => {
    const events: ChatEvent[] = []
    const primary = provider('primary', async function* () {
      throw new NormalizedAIError({ provider: 'primary', category: 'RATE_LIMIT_ERROR', classification: 'transient', retryable: true, message: 'Rate limited' })
    })
    const fallback = provider('backup', async function* (req) {
      expect(req.params?.maxOutputTokens).toBe(8192)
      expect(snapshots(events).at(-1)).toMatchObject({ provider: 'backup', model: 'second', contextWindow: 64_000, outputReserve: 8192 })
      yield { type: 'usage', usage: { inputTokens: 777, outputTokens: 2 } }
      yield { type: 'text_delta', text: 'Done.' }
    })
    service = new ChatService(manager([primary, fallback], { 'primary/first': { contextWindow: 32_000 }, 'backup/second': { contextWindow: 64_000 } }), (event) => { events.push(event) })
    const req = request()
    req.policy.fallbackEnabled = true
    req.policy.fallbacks = [{ providerId: 'backup', model: 'second', params: { maxOutputTokens: 8192 } }]
    await service.start(req)
    await finished(events)
    expect(snapshots(events).at(-1)).toMatchObject({ provider: 'backup', model: 'second', measuredInputTokens: 777, outputReserve: 8192 })
  })

  it.each([false, true])('reflects whether the gated long context window is enabled (%s)', async (longContext) => {
    const events: ChatEvent[] = []
    const model = provider('primary', async function* () { yield { type: 'text_delta', text: 'Done.' } })
    service = new ChatService(manager([model], { 'primary/first': { contextWindow: 1_000_000, longContextBeta: true } }), (event) => { events.push(event) })
    await service.start({ ...request(), longContext })
    await finished(events)
    expect(snapshots(events).at(-1)?.contextWindow).toBe(longContext ? 1_000_000 : 200_000)
    expect(snapshots(events).at(-1)?.measuredInputTokens).toBeUndefined()
  })
})
