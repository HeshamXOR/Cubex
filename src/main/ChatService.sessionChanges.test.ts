import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionMode } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let service: ChatService | undefined
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-session-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
})

afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(root, { recursive: true, force: true })
})

const request = (mode: PermissionMode): ChatStartRequest => ({
  streamId: 's1', conversationId: 'c1', messageId: 'u1', userText: 'go', fileToolsEnabled: true, permissionMode: mode,
  policy: { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
})

/** Script a model: request N yields script[N] (tool calls or text); afterwards it stops. */
function startTurn(script: Array<ToolCall[] | string>, mode: PermissionMode): { events: ChatEvent[]; finished: Promise<void> } {
  const events: ChatEvent[] = []
  let requests = 0
  const provider = {
    id: 'p',
    async *streamMessage(_request: AIRequest): AsyncGenerator<AIStreamEvent> {
      const step = script[requests++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => events.push(event))
  const finished = (async () => {
    await service!.start(request(mode))
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  })()
  return { events, finished }
}

const file = (rel: string): string => join(mocks.workspace, rel)

describe('ChatService session changes', () => {
  it('lists file tool changes, undoes one, and keeps rewind working for the rest', async () => {
    writeFileSync(file('a.txt'), 'original')
    const { finished } = startTurn([
      [{ id: 'r', name: 'read_file', input: { path: 'a.txt' } }],
      [{ id: 'e', name: 'edit_file', input: { path: 'a.txt', old_string: 'original', new_string: 'edited' } }],
      [{ id: 'w', name: 'write_file', input: { path: 'new.txt', content: 'created' } }]
    ], 'bypass')
    await finished
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('edited')

    expect(await service!.getSessionChanges('c1')).toMatchObject([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1, diff: '-original\n+edited' },
      { path: 'new.txt', status: 'added', added: 1, removed: 0 }
    ])
    expect(await service!.revertSessionChanges('c1', ['new.txt'])).toEqual({ restored: ['new.txt'], skipped: [], revertId: expect.any(String) })
    expect(existsSync(file('new.txt'))).toBe(false)

    // The undone file must not block a later rewind as a "changed since" conflict.
    expect(await service!.rewindFiles('c1', 'u1')).toEqual({ restored: [file('a.txt')] })
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('original')
    expect(await service!.getSessionChanges('c1')).toEqual([])
  })

  it('refuses to undo while the task has a running turn', async () => {
    const { events, finished } = startTurn([[{ id: 'w', name: 'write_file', input: { path: 'new.txt', content: 'created' } }]], 'default')
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'permission')).toBe(true), { timeout: 8000 })
    await expect(service!.revertSessionChanges('c1')).rejects.toThrow('Stop the running turn')
    const ask = events.find((e) => e.kind === 'permission')
    if (ask?.kind === 'permission') service!.resolvePermission(ask.ask.id, 'deny')
    await finished
    expect(await service!.revertSessionChanges('c1')).toEqual({ restored: [], skipped: [] })
  })

  it('validates the task and drops stored originals when the conversation is forgotten', async () => {
    const { finished } = startTurn([[{ id: 'w', name: 'write_file', input: { path: 'new.txt', content: 'created' } }]], 'bypass')
    await finished
    const storage = join(mocks.dataRoot, 'session-changes')
    expect(readdirSync(storage)).toHaveLength(1)
    await expect(service!.getSessionChanges('missing')).rejects.toThrow('Task was not found.')
    await expect(service!.getSessionChanges('')).rejects.toThrow('Invalid task id.')

    service!.forgetConversation('c1')
    expect(readdirSync(storage)).toEqual([])
    expect(existsSync(file('new.txt'))).toBe(true)
  })
})
