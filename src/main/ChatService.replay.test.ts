import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest, StoredMessage } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '', messages: [] as StoredMessage[] }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: mocks.messages }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let service: ChatService | undefined
let fixtureRoot: string
beforeEach(() => {
  // Keep fixtures inside the workspace tree: see ChatService.events.test.ts.
  const output = resolve('out')
  mkdirSync(output, { recursive: true })
  fixtureRoot = mkdtempSync(join(output, 'cubex-replay-test-'))
  mocks.dataRoot = join(fixtureRoot, 'data')
  mocks.workspace = join(fixtureRoot, 'workspace')
  mocks.messages = []
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
  writeFileSync(join(mocks.workspace, 'a.txt'), 'first file\n')
  writeFileSync(join(mocks.workspace, 'b.txt'), 'second file\n')
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function request(): ChatStartRequest {
  return {
    streamId: 'stream-one', conversationId: 'task-one', messageId: 'user-one', userText: 'Compare the files.',
    fileToolsEnabled: true, permissionMode: 'bypass',
    policy: { primary: { providerId: 'primary', model: 'test' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}

function startService(stream: (request: AIRequest) => AsyncGenerator<AIStreamEvent>, events: ChatEvent[]): ChatService {
  const provider = { id: 'primary', streamMessage: stream } as unknown as AIProvider
  const manager = { resolve: (id: string) => id === 'primary' ? provider : undefined, getModelInfo: () => undefined } as unknown as ProviderManager
  service = new ChatService(manager, (event) => { events.push(event) })
  return service
}

async function finished(events: ChatEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && e.event.type === 'completed')).toBe(true), { timeout: 5_000 })
  expect(events.filter((e) => e.kind === 'stream' && e.event.type === 'error')).toEqual([])
}

/** Normalized events as AnthropicProvider emits them for [thinking, tool_use, thinking, tool_use]. */
async function* interleavedTurn(): AsyncGenerator<AIStreamEvent> {
  yield { type: 'reasoning_delta', text: 'Read a.txt first.' }
  yield { type: 'metadata', data: { reasoningBlock: { signature: 'sig-A' } } }
  yield { type: 'tool_call_delta', index: 0, id: 'toolu_A', name: 'read_file' }
  yield { type: 'tool_call_delta', index: 0, argsDelta: '{"path":"a.txt"}' }
  yield { type: 'reasoning_delta', text: 'Then b.txt.' }
  yield { type: 'metadata', data: { reasoningBlock: { signature: 'sig-B' } } }
  yield { type: 'tool_call_delta', index: 1, id: 'toolu_B', name: 'read_file' }
  yield { type: 'tool_call_delta', index: 1, argsDelta: '{"path":"b.txt"}' }
  yield { type: 'stop', stopReason: 'tool_use' }
}

describe('ChatService assistant turn replay inside a tool loop', () => {
  it('sends interleaved thinking back in the order the model produced it', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) yield* interleavedTurn()
      else yield { type: 'text_delta', text: 'Both read.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(requests[1]!.messages[1]!.content).toEqual([
      { type: 'reasoning', text: 'Read a.txt first.', signature: 'sig-A' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'reasoning', text: 'Then b.txt.', signature: 'sig-B' },
      { type: 'tool_use', id: 'toolu_B', name: 'read_file', input: { path: 'b.txt' } }
    ])
  })

  it('keeps redacted thinking and text in place', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'metadata', data: { reasoningBlock: { redacted: 'ENCRYPTED' } } }
        yield { type: 'text_delta', text: 'Checking.' }
        yield { type: 'tool_call_delta', index: 0, id: 'toolu_A', name: 'read_file', argsDelta: '{"path":"a.txt"}' }
        yield { type: 'reasoning_delta', text: 'More.' }
        yield { type: 'metadata', data: { reasoningBlock: { signature: 'sig-B' } } }
        yield { type: 'tool_call_delta', index: 1, id: 'toolu_B', name: 'read_file', argsDelta: '{"path":"b.txt"}' }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests[1]!.messages[1]!.content.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool_use', 'reasoning', 'tool_use'])
    expect(requests[1]!.messages[1]!.content[0]).toEqual({ type: 'reasoning', text: '', redacted: 'ENCRYPTED' })
  })

  it('keeps unsigned reasoning so adapters that echo it can', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'reasoning_delta', text: 'Need a.txt.' }
        yield { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'read_file', argsDelta: '{"path":"a.txt"}' }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests[1]!.messages[1]!.content).toEqual([
      { type: 'reasoning', text: 'Need a.txt.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }
    ])
  })
})

describe('ChatService history loaded from storage', () => {
  it('replays older stored turns, which carry only text, unchanged', async () => {
    mocks.messages = [
      { id: 'u1', role: 'user', text: 'Hello', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'Hi there.', createdAt: 2, uiTranscriptJson: '{"version":1,"blocks":[]}' }
    ]
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      yield { type: 'text_delta', text: 'ok' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', [{ type: 'text', text: 'Hello' }]],
      ['assistant', [{ type: 'text', text: 'Hi there.' }]],
      ['user', [{ type: 'text', text: 'Compare the files.' }]]
    ])
  })

  it('replays an earlier turn as its text even when it was stored with provider content parts', async () => {
    // Earlier turns come back without their tool calls and results, so a stored
    // tool_use would have no result, and signed thinking would follow a changed
    // prefix. Only the text of a finished turn is sent on a later one.
    const stored = JSON.stringify([
      { type: 'reasoning', text: 'plan', signature: 'sig-A' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'text', text: 'Done.' }
    ])
    mocks.messages = [
      { id: 'u1', role: 'user', text: 'Hello', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'Reading.Done.', createdAt: 2, contentJson: stored }
    ]
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      yield { type: 'text_delta', text: 'ok' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', [{ type: 'text', text: 'Hello' }]],
      ['assistant', [{ type: 'text', text: 'Reading.Done.' }]],
      ['user', [{ type: 'text', text: 'Compare the files.' }]]
    ])
  })
})
