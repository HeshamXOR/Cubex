import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const output = resolve('out')
  mkdirSync(output, { recursive: true })
  fixtureRoot = mkdtempSync(join(output, 'cubex-turnlog-test-'))
  mocks.dataRoot = join(fixtureRoot, 'data')
  mocks.workspace = join(fixtureRoot, 'workspace')
  mocks.messages = []
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
  writeFileSync(join(mocks.workspace, 'a.txt'), 'first file\n')
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function request(streamId: string, messageId: string, userText: string): ChatStartRequest {
  return {
    streamId, conversationId: 'task-one', messageId, userText,
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

const completedCount = (events: ChatEvent[]): number => events.filter((e) => e.kind === 'stream' && e.event.type === 'completed').length
async function finishedTurns(events: ChatEvent[], count: number): Promise<void> {
  await vi.waitFor(() => expect(completedCount(events)).toBe(count), { timeout: 5_000 })
  expect(events.filter((e) => e.kind === 'stream' && e.event.type === 'error')).toEqual([])
}

describe('a later turn sees what the model did in an earlier one', () => {
  it('replays the tool calls and results of a finished turn instead of only its text', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req) {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'reasoning_delta', text: 'Need a.txt.' }
        yield { type: 'text_delta', text: 'Reading a.txt.' }
        yield { type: 'tool_call_delta', index: 0, id: 'toolu_A', name: 'read_file', argsDelta: '{"path":"a.txt"}' }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: requests.length === 2 ? 'It says "first file".' : 'Yes, I read it earlier.' }
    }, events)

    await chat.start(request('s1', 'u1', 'What does a.txt say?'))
    await finishedTurns(events, 1)
    expect(existsSync(join(mocks.dataRoot, 'turn-log', 'task-one.json'))).toBe(true)

    // The window stores both messages when the turn settles; the next message comes in on top of them.
    mocks.messages = [
      { id: 'u1', role: 'user', text: 'What does a.txt say?', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'Reading a.txt.It says "first file".', createdAt: 2 }
    ]
    await chat.start(request('s2', 'u2', 'Did you read it?'))
    await finishedTurns(events, 2)

    const third = requests[2]!
    expect(third.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(third.messages[1]!.content.map((p) => p.type)).toEqual(['text', 'tool_use'])
    expect(third.messages[1]!.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.txt' } })
    expect(third.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_A' })
    expect(JSON.stringify(third.messages[2])).toMatch(/first file/)
    // Thinking is not carried into later turns.
    expect(JSON.stringify(third.messages)).not.toMatch(/Need a\.txt/)
    expect(third.messages[3]!.content).toEqual([{ type: 'text', text: 'It says "first file".' }])
  })
})
