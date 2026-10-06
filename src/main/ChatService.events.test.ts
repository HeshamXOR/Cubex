import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, ToolActivity } from '@shared/ipc'
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
  // Keep shell fixtures within the allowed workspace: this Windows sandbox can
  // allow Node writes in TEMP while denying a subprocess access to that folder.
  const output = resolve('out')
  mkdirSync(output, { recursive: true })
  fixtureRoot = mkdtempSync(join(output, 'cubex-events-test-'))
  mocks.dataRoot = join(fixtureRoot, 'data')
  mocks.workspace = join(fixtureRoot, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
  writeFileSync(join(mocks.workspace, 'note.txt'), 'A file inspected by the model.\n')
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function request(streamId = 'stream-one', conversationId = 'task-one'): ChatStartRequest {
  return {
    streamId, conversationId, messageId: `user-${conversationId}`, userText: 'Inspect and correct the fixture.',
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

async function finished(events: ChatEvent[], streamId = 'stream-one'): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.streamId === streamId && event.kind === 'stream' && event.event.type === 'completed')).toBe(true), { timeout: 5_000 })
  expect(events.filter((event) => event.streamId === streamId && event.kind === 'stream' && event.event.type === 'error')).toEqual([])
}

function terminalTools(events: ChatEvent[], name: string): ToolActivity[] {
  return events.flatMap((event) => event.kind === 'tool' && event.tool.name === name && event.tool.phase !== 'running' ? [event.tool] : [])
}

function timeline(events: ChatEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.kind === 'iteration') return [`iteration:${event.iteration}`]
    if (event.kind === 'tool') return [`${event.tool.name}:${event.tool.phase}`]
    if (event.kind === 'stream' && event.event.type === 'text_delta') return [`text:${event.event.text}`]
    if (event.kind === 'stream' && event.event.type === 'completed') return ['completed']
    return []
  })
}

function response(text: string, toolCalls: ToolCall[] = []): AIResponse {
  return {
    id: 'provider-response', provider: 'primary', model: 'test', text, toolCalls,
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((call) => ({ type: 'tool_use' as const, ...call }))
    ],
    stopReason: toolCalls.length ? 'tool_use' : 'stop', createdAt: Date.now()
  }
}

const readCall: ToolCall = { id: 'read-note', name: 'read_file', input: { path: 'note.txt' } }

describe('ChatService event order and failed-call recovery', () => {
  it('assigns contiguous independent event sequences and immutable ownership to concurrent streams', async () => {
    const events: ChatEvent[] = []
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chat = startService(async function* (): AsyncGenerator<AIStreamEvent> {
      entered++
      yield { type: 'text_delta', text: 'Starting. ' }
      await gate
      yield { type: 'text_delta', text: 'Finished.' }
    }, events)
    try {
      await Promise.all([chat.start(request('stream-a', 'task-a')), chat.start(request('stream-b', 'task-b'))])
      await vi.waitFor(() => expect(entered).toBe(2))
      release()
      await Promise.all([finished(events, 'stream-a'), finished(events, 'stream-b')])
      for (const suffix of ['a', 'b']) {
        const own = events.filter((event) => event.streamId === `stream-${suffix}`)
        expect(own.length).toBeGreaterThan(5)
        expect(own.map((event) => event.sequence)).toEqual(own.map((_, index) => index + 1))
        expect(own.every((event) => event.conversationId === `task-${suffix}` && event.parentMessageId === `user-task-${suffix}`)).toBe(true)
        expect(own.filter((event) => event.kind === 'iteration')).toMatchObject([{ iteration: 1 }])
      }
    } finally { release() }
  })

  it('keeps iteration text before its tool and retains that text in the next model request', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'text_delta', text: 'Inspecting ' }
        yield { type: 'text_delta', text: 'one file.' }
        yield { type: 'tool_call', toolCall: readCall }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Inspection complete.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(2)
    expect(timeline(events)).toEqual([
      'iteration:1', 'text:Inspecting ', 'text:one file.', 'read_file:running', 'read_file:done',
      'iteration:2', 'text:Inspection complete.', 'completed'
    ])
    expect(requests[1]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(requests[1]!.messages[1]!.content).toEqual([
      { type: 'text', text: 'Inspecting one file.' }, { type: 'tool_use', ...readCall }
    ])
    expect(JSON.stringify(requests[1]!.messages[2])).toContain('A file inspected by the model.')
  })

  it.each(['full', 'prefix'] as const)('does not repeat streamed text when a provider completes with %s text coverage', async (coverage) => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const text = 'Inspecting one file.'
    const firstText = coverage === 'full' ? text : 'Inspecting '
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'text_delta', text: firstText }
        yield { type: 'tool_call', toolCall: readCall }
        yield { type: 'completed', response: response(text, [readCall]) }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    const expectedText = coverage === 'full' ? [`text:${text}`] : ['text:Inspecting ', 'text:one file.']
    expect(timeline(events)).toEqual([
      'iteration:1', ...expectedText, 'read_file:running', 'read_file:done', 'iteration:2', 'text:Done.', 'completed'
    ])
    expect(requests[1]!.messages[1]!.content.filter((part) => part.type === 'text')).toEqual([{ type: 'text', text }])
  })

  it('preserves completion-only intermediate text and tools before a completion-only final reply', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      yield { type: 'completed', response: requests.length === 1 ? response('Reading the file now.', [readCall]) : response('Read and verified.') }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(2)
    expect(timeline(events)).toEqual([
      'iteration:1', 'text:Reading the file now.', 'read_file:running', 'read_file:done',
      'iteration:2', 'text:Read and verified.', 'completed'
    ])
    expect(requests[1]!.messages[1]!.content).toEqual([
      { type: 'text', text: 'Reading the file now.' }, { type: 'tool_use', ...readCall }
    ])
  })

  it.each(['file', 'shell'])('executes an identical failed command once despite reordered input keys and an intervening %s read', async (readKind) => {
    writeFileSync(join(mocks.workspace, 'probe.cjs'), "require('node:fs').appendFileSync('attempts.txt', 'run\\n'); console.error('fixture command failed'); process.exitCode = 7")
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const command = 'node probe.cjs'
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      const turn = requests.length
      if (turn === 2) yield { type: 'tool_call', toolCall: readKind === 'file' ? readCall : { id: 'shell-probe', name: 'run_command', input: { command: 'echo harmless-probe' } } }
      else if (turn < 5) yield { type: 'tool_call', toolCall: {
        id: `failed-${turn}`, name: 'run_command',
        input: turn === 1 ? { command, timeout_ms: 5000 } : { timeout_ms: 5000, command }
      } }
      else yield { type: 'text_delta', text: 'The failure needs a different correction.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(5)
    expect(readFileSync(join(mocks.workspace, 'attempts.txt'), 'utf8')).toBe('run\n')
    expect(events.filter((event) => event.kind === 'tool' && event.tool.name === 'run_command' && event.tool.phase === 'running' && event.tool.id !== 'shell-probe')).toHaveLength(1)
    const failed = terminalTools(events, 'run_command').filter((tool) => tool.id !== 'shell-probe')
    expect(failed).toHaveLength(3)
    expect(failed[0]).toMatchObject({ phase: 'error', outputId: expect.any(String) })
    for (const suppressed of failed.slice(1)) {
      expect(suppressed).toMatchObject({ phase: 'error', detail: expect.stringContaining('This exact call already failed') })
      expect(suppressed.outputId).toBeUndefined()
    }
    const lastResult = requests[4]!.messages.at(-1)!
    expect(JSON.stringify(lastResult)).toContain('Previous failure:')
    expect(JSON.stringify(lastResult)).toContain('fixture command failed')
  })

  it('allows retrying a failed command after a successful file correction', async () => {
    writeFileSync(join(mocks.workspace, 'probe.cjs'), [
      "const fs = require('node:fs')",
      "fs.appendFileSync('attempts.txt', 'run\\n')",
      "if (!fs.existsSync('ready.txt')) { console.error('Missing ready.txt'); process.exitCode = 2 } else console.log('Correction verified')"
    ].join('\n'))
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      const turn = requests.length
      if (turn === 1 || turn === 3) yield { type: 'tool_call', toolCall: { id: `run-${turn}`, name: 'run_command', input: { command: 'node probe.cjs' } } }
      else if (turn === 2) yield { type: 'tool_call', toolCall: { id: 'correct-file', name: 'write_file', input: { path: 'ready.txt', content: 'ready' } } }
      else yield { type: 'text_delta', text: 'Correction verified.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(requests).toHaveLength(4)
    expect(readFileSync(join(mocks.workspace, 'attempts.txt'), 'utf8')).toBe('run\nrun\n')
    expect(readFileSync(join(mocks.workspace, 'ready.txt'), 'utf8')).toBe('ready')
    expect(terminalTools(events, 'write_file')).toMatchObject([{ id: 'correct-file', phase: 'done' }])
    expect(terminalTools(events, 'run_command').map((tool) => tool.phase)).toEqual(['error', 'done'])
    expect(JSON.stringify(requests[3]!.messages.at(-1))).toContain('Correction verified')
  })

  it.each(['edit_file', 'write_file', 'remove_file'])('recovers a failed %s after reading the same normalized file, but not an unrelated file', async (name) => {
    writeFileSync(join(mocks.workspace, 'other.txt'), 'Unrelated file')
    const input: ToolCall['input'] = name === 'edit_file'
      ? { path: 'note.txt', old_string: 'A file inspected', new_string: 'A file corrected' }
      : name === 'write_file' ? { path: 'note.txt', content: 'Replacement file contents.\n' } : { path: 'note.txt' }
    const events: ChatEvent[] = []
    let turn = 0
    const chat = startService(async function* (): AsyncGenerator<AIStreamEvent> {
      turn++
      if (turn === 1 || turn === 3 || turn === 5) yield { type: 'tool_call', toolCall: { id: `mutation-${turn}`, name, input } }
      else if (turn === 2) yield { type: 'tool_call', toolCall: { id: 'unrelated-read', name: 'read_file', input: { path: 'other.txt' } } }
      else if (turn === 4) yield { type: 'tool_call', toolCall: { id: 'recovery-read', name: 'read_file', input: { path: process.platform === 'win32' ? '.\\NOTE.txt' : './note.txt' } } }
      else yield { type: 'text_delta', text: 'File operation recovered.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(turn).toBe(6)
    expect(terminalTools(events, name)).toMatchObject([
      { id: 'mutation-1', phase: 'error', detail: expect.stringContaining('Call read_file') },
      { id: 'mutation-3', phase: 'error', detail: expect.stringContaining('This exact call already failed') },
      { id: 'mutation-5', phase: 'done' }
    ])
    if (name === 'remove_file') expect(existsSync(join(mocks.workspace, 'note.txt'))).toBe(false)
    else expect(readFileSync(join(mocks.workspace, 'note.txt'), 'utf8')).toBe(name === 'edit_file' ? 'A file corrected by the model.\n' : 'Replacement file contents.\n')
  })

  it.each(['edit_file', 'write_file'])('recovers a stale %s after refreshing the read without another workspace mutation', async (name) => {
    const input: ToolCall['input'] = name === 'edit_file'
      ? { path: 'note.txt', old_string: 'A file inspected', new_string: 'A file corrected' }
      : { path: 'note.txt', content: 'Reviewed replacement.\n' }
    const events: ChatEvent[] = []
    let turn = 0
    const chat = startService(async function* (): AsyncGenerator<AIStreamEvent> {
      turn++
      if (turn === 1 || turn === 3) yield { type: 'tool_call', toolCall: { id: `read-${turn}`, name: 'read_file', input: { path: './note.txt' } } }
      else if (turn === 2 || turn === 4) {
        if (turn === 2) writeFileSync(join(mocks.workspace, 'note.txt'), 'A file inspected by the model.\nA newer manual edit.\n')
        yield { type: 'tool_call', toolCall: { id: `mutation-${turn}`, name, input } }
      } else yield { type: 'text_delta', text: 'Fresh contents reviewed and changed.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(turn).toBe(5)
    expect(terminalTools(events, name)).toMatchObject([
      { id: 'mutation-2', phase: 'error', detail: expect.stringContaining('File changed since you read it') },
      { id: 'mutation-4', phase: 'done' }
    ])
    expect(readFileSync(join(mocks.workspace, 'note.txt'), 'utf8')).toBe(name === 'edit_file'
      ? 'A file corrected by the model.\nA newer manual edit.\n' : 'Reviewed replacement.\n')
  })

  it('does not unlock a failed mutation after a failed read of that same file', async () => {
    const events: ChatEvent[] = []
    let turn = 0
    const chat = startService(async function* (): AsyncGenerator<AIStreamEvent> {
      turn++
      if (turn === 1 || turn === 3) yield { type: 'tool_call', toolCall: { id: `mutation-${turn}`, name: 'edit_file', input: { path: 'note.txt', old_string: 'inspected', new_string: 'changed' } } }
      else if (turn === 2) yield { type: 'tool_call', toolCall: { id: 'invalid-read', name: 'read_file', input: { path: 'note.txt', offset: -1 } } }
      else yield { type: 'text_delta', text: 'The read input must be corrected first.' }
    }, events)
    await chat.start(request())
    await finished(events)
    expect(terminalTools(events, 'read_file')).toMatchObject([{ phase: 'error' }])
    expect(terminalTools(events, 'edit_file')).toMatchObject([
      { phase: 'error', detail: expect.stringContaining('Call read_file') },
      { phase: 'error', detail: expect.stringContaining('This exact call already failed') }
    ])
    expect(readFileSync(join(mocks.workspace, 'note.txt'), 'utf8')).toBe('A file inspected by the model.\n')
  })
})
