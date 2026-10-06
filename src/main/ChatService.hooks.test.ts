import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { HookConfig } from '@shared/settings'
import type { HookOutcome, HookPayload } from './hooks'
import type { ProviderManager } from './ProviderManager'

interface HookRun { hooks: HookConfig[] | undefined; payload: HookPayload; cwd: string | undefined }

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  workspace: '',
  hooks: [] as HookConfig[],
  runs: [] as HookRun[],
  verdict: (_payload: HookPayload): HookOutcome => ({ block: false })
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: mocks.hooks }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
// The real runner starts shell commands; what matters here is what ChatService hands it and when.
vi.mock('./hooks', () => ({
  runHooks: async (hooks: HookConfig[] | undefined, payload: HookPayload, cwd?: string): Promise<HookOutcome> => {
    mocks.runs.push({ hooks, payload, cwd })
    return mocks.verdict(payload)
  }
}))

import { ChatService } from './ChatService'

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-hooks-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.hooks = [
    { id: 'h1', event: 'UserPromptSubmit', command: 'echo prompt', enabled: true },
    { id: 'h2', event: 'Stop', command: 'echo stop', enabled: true }
  ]
  mocks.runs = []
  mocks.verdict = () => ({ block: false })
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const answering = (text: string): AIProvider => ({
  id: 'p',
  async *streamMessage(): AsyncGenerator<AIStreamEvent> { yield { type: 'text_delta', text } }
}) as unknown as AIProvider

/** A model whose connection breaks as soon as the turn reads from it. */
const unreachable = (): AIProvider => ({
  id: 'p',
  streamMessage: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('The model service is unreachable.')) }) })
}) as unknown as AIProvider

/** One turn against `provider`; resolves with the events once the turn has completed or failed. */
async function turn(provider: AIProvider, userText: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  const service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => { events.push(event) })
  services.push(service)
  const request: ChatStartRequest = { streamId: 's1', conversationId: 'c1', messageId: 'u1', userText, fileToolsEnabled: true, permissionMode: 'default', policy }
  await service.start(request)
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  return events
}
const ran = (): string[] => mocks.runs.map((run) => run.payload.event)
const ended = (events: ChatEvent[], type: 'completed' | 'error'): boolean => events.some((e) => e.kind === 'stream' && e.event.type === type)

describe('UserPromptSubmit and Stop hooks', () => {
  it('runs the prompt hook as the turn starts and the stop hook when it ends, in the project folder', async () => {
    await turn(answering('Done.'), 'Add a retry to the upload helper.')
    await vi.waitFor(() => expect(ran()).toEqual(['UserPromptSubmit', 'Stop']))
    const [prompt, stop] = mocks.runs
    expect(prompt).toMatchObject({ payload: { event: 'UserPromptSubmit', prompt: 'Add a retry to the upload helper.', cwd: mocks.workspace }, cwd: mocks.workspace })
    expect(stop).toMatchObject({ payload: { event: 'Stop', cwd: mocks.workspace }, cwd: mocks.workspace })
    expect(stop?.payload.prompt).toBeUndefined()
    // Both receive the saved list; picking the hooks that match the event is the runner's job.
    expect(prompt?.hooks).toBe(mocks.hooks)
    expect(stop?.hooks).toBe(mocks.hooks)
  })

  it('sends the prompt hook at most 2000 characters of a long message', async () => {
    await turn(answering('ok'), 'x'.repeat(5000))
    expect(mocks.runs[0]?.payload.prompt).toHaveLength(2000)
  })

  it('does not let a block answer from the prompt or stop hook change the turn', async () => {
    mocks.verdict = () => ({ block: true, reason: 'not today' })
    const events = await turn(answering('Done.'), 'hello')
    expect(ended(events, 'completed')).toBe(true)
    expect(ended(events, 'error')).toBe(false)
    await vi.waitFor(() => expect(ran()).toEqual(['UserPromptSubmit', 'Stop']))
  })

  it('still runs the stop hook when the model fails', async () => {
    const events = await turn(unreachable(), 'hello')
    expect(ended(events, 'error')).toBe(true)
    await vi.waitFor(() => expect(ran()).toEqual(['UserPromptSubmit', 'Stop']))
  })
})
