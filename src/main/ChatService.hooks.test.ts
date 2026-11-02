import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
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
  /** Every run, SessionStart included; `runs` leaves it out so the tests of other events stay about those. */
  all: [] as HookRun[],
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
    mocks.all.push({ hooks, payload, cwd })
    if (payload.event !== 'SessionStart') mocks.runs.push({ hooks, payload, cwd })
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
  mocks.all = []
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

/** A model that gives each request the next of `replies` (the last one repeats), and keeps what it was asked. */
const scripted = (replies: string[], seen: AIRequest[]): AIProvider => ({
  id: 'p',
  async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
    seen.push(request)
    yield { type: 'text_delta', text: replies[Math.min(seen.length - 1, replies.length - 1)]! }
  }
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

  it('stops the turn before any request when the prompt hook blocks, and shows the reason as the error', async () => {
    mocks.verdict = (payload) => payload.event === 'UserPromptSubmit' ? { block: true, reason: 'not today' } : { block: false }
    const seen: AIRequest[] = []
    const events = await turn(scripted(['never sent'], seen), 'hello')
    expect(ended(events, 'error')).toBe(true)
    expect(ended(events, 'completed')).toBe(false)
    const error = events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'error' ? [e.event.error] : []))[0]
    expect(error?.message).toContain('not today')
    expect(seen).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(ran()).toEqual(['UserPromptSubmit'])
  })

  it('adds the context a prompt hook prints to the message the model gets', async () => {
    mocks.verdict = (payload) => payload.event === 'UserPromptSubmit' ? { block: false, additionalContext: 'Branch policy: never touch main.' } : { block: false }
    const seen: AIRequest[] = []
    await turn(scripted(['ok'], seen), 'hello')
    const last = seen[0]!.messages.at(-1)!
    expect(JSON.stringify(last.content)).toContain('hello')
    expect(JSON.stringify(last.content)).toContain('Branch policy: never touch main.')
  })

  it('lets a stop hook that blocks send the agent back to work, with its message', async () => {
    let asked = 0
    mocks.verdict = (payload) => payload.event === 'Stop' && asked++ === 0 ? { block: true, reason: 'The tests are not green yet.' } : { block: false }
    const seen: AIRequest[] = []
    const events = await turn(scripted(['First answer.', 'Second answer.'], seen), 'hello')
    await new Promise((resolve) => setTimeout(resolve, 80))
    // A second request, which carries the first answer and the hook's message, and one end of the turn, after it.
    expect(seen).toHaveLength(2)
    const second = JSON.stringify(seen[1]!.messages)
    expect(second).toContain('First answer.')
    expect(second).toContain('A Stop hook asked you to keep working before you finish.')
    expect(second).toContain('The tests are not green yet.')
    expect(events.filter((e) => e.kind === 'stream' && e.event.type === 'completed')).toHaveLength(1)
    const card = events.find((e) => e.kind === 'tool' && e.tool.name === 'stop_hook')
    expect(card).toMatchObject({ tool: { phase: 'done', title: 'Stop hook asked for more work', detail: 'The tests are not green yet.' } })
    // The hook is told when it is being asked a second time, and is not run again after the turn ends.
    expect(mocks.runs.filter((run) => run.payload.event === 'Stop').map((run) => run.payload.stop_hook_active)).toEqual([false, true])
  })

  it('ends the turn after three requests for more work, and says so', async () => {
    mocks.verdict = (payload) => payload.event === 'Stop' ? { block: true, reason: 'again' } : { block: false }
    const seen: AIRequest[] = []
    const events = await turn(scripted(['a'], seen), 'hello')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(seen).toHaveLength(4)
    expect(mocks.runs.filter((run) => run.payload.event === 'Stop')).toHaveLength(4)
    const text = events.flatMap((e) => (e.kind === 'stream' && e.event.type === 'text_delta' ? [e.event.text] : [])).join('')
    expect(text).toContain('A Stop hook asked for more work 3 times')
    expect(ended(events, 'completed')).toBe(true)
  })
})

/** A service whose permission prompts are answered with "allow", over the scripted model. */
async function run(steps: Array<ToolCall[] | string>, options: { mode?: ChatStartRequest['permissionMode']; turns?: number } = {}): Promise<{ events: ChatEvent[]; seen: AIRequest[] }> {
  const events: ChatEvent[] = []
  const seen: AIRequest[] = []
  let requests = 0
  const provider = {
    id: 'p',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      seen.push(request)
      const step = steps[Math.min(requests++, steps.length - 1)]!
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') queueMicrotask(() => service.resolvePermission(event.ask.id, 'allow'))
  })
  services.push(service)
  for (let n = 1; n <= (options.turns ?? 1); n++) {
    const from = events.length
    await service.start({
      streamId: `s${n}`, conversationId: 'c1', messageId: `u${n}`, userText: 'go', fileToolsEnabled: true,
      permissionMode: options.mode ?? 'default', policy
    })
    await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  }
  return { events, seen }
}
const write = (id: string, path: string, content = 'x'): ToolCall => ({ id, name: 'write_file', input: { path, content } })

describe('hooks v2', () => {
  it('runs SessionStart on the first turn of a conversation only', async () => {
    await run(['one'], { turns: 2 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(mocks.all.filter((r) => r.payload.event === 'SessionStart')).toHaveLength(1)
    expect(mocks.all[0]?.payload).toMatchObject({ event: 'SessionStart', session_id: 'c1', cwd: mocks.workspace })
  })

  it('runs the tool with the input a PreToolUse hook printed, through the permission gate again', async () => {
    mocks.verdict = (payload) => payload.event === 'PreToolUse' && (payload.tool_input as { path?: string }).path === 'a.txt'
      ? { block: false, updatedInput: { path: 'b.txt', content: 'rewritten' } } : { block: false }
    const { events } = await run([[write('w1', 'a.txt', 'original')], 'done'])
    expect(existsSync(join(mocks.workspace, 'a.txt'))).toBe(false)
    expect(readFileSync(join(mocks.workspace, 'b.txt'), 'utf8')).toBe('rewritten')
    // Asked for the call as the model made it and again for the call as it runs.
    const asks = events.flatMap((e) => (e.kind === 'permission' ? [e.ask] : []))
    expect(asks).toHaveLength(2)
    expect(asks[1]!.title).toContain('b.txt')
    const card = events.filter((e) => e.kind === 'tool' && e.tool.id === 'w1').at(-1)
    expect(card).toMatchObject({ tool: { phase: 'done', title: expect.stringContaining('b.txt') } })
    // The hooks after it see the input that ran, and PreToolUse is not asked twice.
    expect(mocks.all.filter((r) => r.payload.event === 'PreToolUse')).toHaveLength(1)
    expect(mocks.all.find((r) => r.payload.event === 'PostToolUse')?.payload.tool_input).toMatchObject({ path: 'b.txt' })
  })

  it('still validates and gates the replaced input: a protected path is refused', async () => {
    mocks.verdict = (payload) => payload.event === 'PreToolUse' ? { block: false, updatedInput: { path: '../outside.txt', content: 'x' } } : { block: false }
    const { events } = await run([[write('w1', 'a.txt')], 'done'], { mode: 'bypass' })
    expect(existsSync(join(mocks.workspace, '..', 'outside.txt'))).toBe(false)
    expect(events.filter((e) => e.kind === 'tool' && e.tool.id === 'w1').at(-1)).toMatchObject({ tool: { phase: 'error' } })
  })
})
