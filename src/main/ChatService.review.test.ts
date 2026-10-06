import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionMode, ReviewComment } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '', conversation: { providerId: undefined as string | undefined, model: undefined as string | undefined } }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [], ...mocks.conversation } : null) }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], ai: { fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: { requestMs: 5000 } } }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

const lines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n') + '\n'
const file = (rel: string): string => join(mocks.workspace, rel)
const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }

let service: ChatService
let events: ChatEvent[]
let requests: AIRequest[]
let script: Array<ToolCall[] | string>
let step: number
let root: string
let streams: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-review-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.conversation = { providerId: undefined, model: undefined }
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
  events = []
  requests = []
  script = []
  step = 0
  streams = 0
  const provider = {
    id: 'p',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(request)
      const next = script[step++] ?? 'done'
      if (typeof next === 'string') yield { type: 'text_delta', text: next }
      else for (const toolCall of next) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => events.push(event))
})

afterEach(() => {
  service.cancelAll()
  service.dispose()
  rmSync(root, { recursive: true, force: true })
})

const settled = (streamId: string): Promise<void> => vi.waitFor(() => {
  expect(events.some((e) => e.streamId === streamId && e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true)
}, { timeout: 8000 })

/** A turn of the scripted model: request N yields steps[N] (tool calls or text); afterwards it says "done". */
async function turn(steps: Array<ToolCall[] | string>, overrides: Partial<ChatStartRequest> = {}): Promise<string> {
  script = steps
  step = 0
  const streamId = `s${++streams}`
  await service.start({ streamId, conversationId: 'c1', messageId: `u${streams}`, userText: 'go', fileToolsEnabled: true, permissionMode: 'bypass', policy, ...overrides })
  await settled(streamId)
  return streamId
}

const edit = (id: string, from: string, to: string): ToolCall => ({ id, name: 'edit_file', input: { path: 'a.txt', old_string: from, new_string: to } })

/** A task whose a.txt has two hunks, made by the model in one turn. */
async function editedTask(permissionMode: PermissionMode = 'bypass'): Promise<string> {
  writeFileSync(file('a.txt'), lines(30))
  return turn([[{ id: 'r', name: 'read_file', input: { path: 'a.txt' } }], [edit('e1', 'line 5\n', 'five changed\n'), edit('e2', 'line 25\n', 'twenty-five changed\n')]], { permissionMode })
}

const userTexts = (request: AIRequest): string[] =>
  request.messages.filter((m) => m.role === 'user').flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))))

describe('review events', () => {
  it('announces each change to the review state, riding the turn while there is one and naming the task after it', async () => {
    const stream = await editedTask()
    const during = events.filter((e) => e.kind === 'review')
    expect(during.length).toBeGreaterThanOrEqual(2)
    expect(during.every((e) => e.streamId === stream && e.conversationId === 'c1' && e.sequence !== undefined)).toBe(true)

    const revisions = (): number[] => events.flatMap((e) => (e.kind === 'review' ? [e.revision] : []))
    const afterTurn = revisions().length
    const [review] = await service.getReview('c1', { kind: 'session' })
    expect(review!.hunks).toHaveLength(2)
    expect(revisions()).toHaveLength(afterTurn)

    await service.markReviewed('c1', [{ path: 'a.txt', hunkIds: [review!.hunks[0]!.id], headHash: review!.headHash! }])
    const reverted = await service.revertHunks('c1', { path: 'a.txt', hunkIds: [review!.hunks[1]!.id], expectHeadHash: review!.headHash! })
    await service.undoRevert('c1', reverted.revertId!)

    const late = events.filter((e) => e.kind === 'review').slice(afterTurn)
    expect(late).toHaveLength(3)
    expect(late.every((e) => e.streamId === 'review:c1' && e.conversationId === 'c1')).toBe(true)
    const all = revisions()
    expect(all).toEqual([...all].sort((a, b) => a - b))
    expect(new Set(all).size).toBe(all.length)
  })

  it('reverts a hunk, leaves the rest, and keeps a later rewind from stopping on the file', async () => {
    await editedTask()
    const [review] = await service.getReview('c1', { kind: 'session' })
    const result = await service.revertHunks('c1', { path: 'a.txt', hunkIds: [review!.hunks[0]!.id], expectHeadHash: review!.headHash! })
    expect(result).toMatchObject({ applied: [review!.hunks[0]!.id], conflicts: [] })
    expect(readFileSync(file('a.txt'), 'utf8').split('\n').slice(5, 6)).toEqual(['line 5'])
    expect(readFileSync(file('a.txt'), 'utf8')).toContain('twenty-five changed')
    // The snapshots no longer describe this file, so the rewind skips it instead of refusing to run at all.
    await expect(service.rewindFiles('c1', 'u1')).resolves.toEqual({ restored: [] })
  })

  it('refuses to undo while a turn runs, and says so before touching the file', async () => {
    await editedTask()
    const [review] = await service.getReview('c1', { kind: 'session' })
    const reverted = await service.revertHunks('c1', { path: 'a.txt', hunkIds: [review!.hunks[0]!.id], expectHeadHash: review!.headHash! })
    script = [[{ id: 'w', name: 'write_file', input: { path: 'new.txt', content: 'x' } }]]
    step = 0
    await service.start({ streamId: 'busy', conversationId: 'c1', userText: 'again', fileToolsEnabled: true, permissionMode: 'default', policy })
    await vi.waitFor(() => expect(events.some((e) => e.streamId === 'busy' && e.kind === 'permission')).toBe(true), { timeout: 8000 })
    const [now] = await service.getReview('c1', { kind: 'session' })
    const before = readFileSync(file('a.txt'), 'utf8')
    await expect(service.revertHunks('c1', { path: 'a.txt', hunkIds: [now!.hunks[0]!.id], expectHeadHash: now!.headHash! })).rejects.toThrow('Stop the running turn')
    await expect(service.undoRevert('c1', reverted.revertId ?? '')).rejects.toThrow('Stop the running turn')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe(before)
    const ask = events.find((e) => e.streamId === 'busy' && e.kind === 'permission')
    if (ask?.kind === 'permission') service.resolvePermission(ask.ask.id, 'deny')
    await settled('busy')
  })

  it('reports no hunks for a task without a folder and validates the task', async () => {
    await expect(service.getReview('missing', { kind: 'session' })).rejects.toThrow('Task was not found.')
    await expect(service.getReview('', { kind: 'session' })).rejects.toThrow('Invalid task id.')
    expect(await service.getReview('c1', { kind: 'session' })).toEqual([])
  })
})

describe('review notes for the model', () => {
  it('reach the model with the next message, once, and end the window for Undo', async () => {
    await editedTask()
    const [review] = await service.getReview('c1', { kind: 'session' })
    await service.markReviewed('c1', [{ path: 'a.txt', hunkIds: [review!.hunks[1]!.id], headHash: review!.headHash! }])
    const reverted = await service.revertHunks('c1', { path: 'a.txt', hunkIds: [review!.hunks[0]!.id], expectHeadHash: review!.headHash! })

    requests.length = 0
    await turn(['Understood.'], { userText: 'continue' })
    const first = userTexts(requests[0]!)
    expect(first.at(-2)).toBe('continue')
    expect(first.at(-1)).toMatch(/^<review-state>\nReverted in a\.txt: line 6\nAccepted in a\.txt: 1 hunk\n<\/review-state>$/)

    requests.length = 0
    await turn(['Fine.'], { userText: 'and again' })
    expect(userTexts(requests[0]!).join('\n')).not.toContain('<review-state>')
    await expect(service.undoRevert('c1', reverted.revertId!)).rejects.toThrow(/expired|not found/)
  })

  it('send nothing when the person reviewed nothing', async () => {
    await editedTask()
    requests.length = 0
    await turn(['ok'], { userText: 'continue' })
    expect(userTexts(requests[0]!).at(-1)).toBe('continue')
  })
})

describe('sendReviewComments', () => {
  const comment = (id: string, hunkId: string, extra: Partial<ReviewComment> = {}): ReviewComment =>
    ({ id, path: 'a.txt', startLine: 6, endLine: 6, side: 'new', hunkId, text: 'Why this wording?', ...extra })

  it('writes one message from the comments, shows it before the turn starts and runs the turn like the last one', async () => {
    await editedTask()
    const [review] = await service.getReview('c1', { kind: 'session' })
    events.length = 0
    requests.length = 0
    const result = await service.sendReviewComments('c1', [comment('k1', review!.hunks[0]!.id), comment('k2', review!.hunks[1]!.id, { startLine: 26, endLine: 26, text: 'Keep the number.' })], { streamId: 'cmt' })
    await settled('cmt')

    expect(result.streamId).toBe('cmt')
    expect(result.messageId).toMatch(/\S+/)
    expect(result.text).toContain('Review comments on your changes: 2 comments in 1 file.')
    // Each comment covers all its hunk changed, so the whole hunk is quoted, context included.
    expect(result.text).toContain('1. Line 6\n```diff\n line 2\n line 3\n line 4\n-line 5\n+five changed\n line 6\n line 7\n line 8\n```\nWhy this wording?')
    expect(result.text).toContain('2. Line 26\n```diff\n line 22\n line 23\n line 24\n-line 25\n+twenty-five changed\n line 26\n line 27\n line 28\n```\nKeep the number.')

    const mine = events.filter((e) => e.streamId === 'cmt')
    // The window learns of the message before anything else arrives on the stream.
    expect(mine[0]).toMatchObject({ kind: 'userMessage', messageId: result.messageId, text: result.text, conversationId: 'c1', parentMessageId: result.messageId, sequence: 1 })
    expect(mine.slice(1).some((e) => e.kind === 'userMessage')).toBe(false)
    expect(requests[0]!.model).toBe('m')
    expect(userTexts(requests[0]!).at(-1)).toBe(result.text)
  })

  it('uses what the window asks for, and never plan mode that the last turn left behind', async () => {
    await editedTask()
    await turn(['Here is a plan.'], { permissionMode: 'plan' })
    const [review] = await service.getReview('c1', { kind: 'session' })
    const send = async (overrides?: { target?: { providerId: string; model: string }; permissionMode?: PermissionMode }): Promise<void> => {
      const { streamId } = await service.sendReviewComments('c1', [comment('k', review!.hunks[0]!.id)], overrides ? { overrides } : {})
      await settled(streamId)
    }

    requests.length = 0
    await send()
    // Plan mode adds the exit_plan_mode tool and says so in the system prompt; the comment turn must not.
    expect(requests[0]!.tools?.some((tool) => tool.name === 'exit_plan_mode')).toBeFalsy()

    requests.length = 0
    await send({ target: { providerId: 'p2', model: 'other-model' }, permissionMode: 'plan' })
    expect(requests[0]!.model).toBe('other-model')
    expect(requests[0]!.tools?.some((tool) => tool.name === 'exit_plan_mode')).toBe(true)
  })

  it('falls back to the model the task was created with, and asks for one when there is none', async () => {
    writeFileSync(file('a.txt'), lines(30))
    const fresh = new ChatService({ resolve: () => ({ id: 'p', async *streamMessage(request: AIRequest) { requests.push(request); yield { type: 'text_delta', text: 'ok' } } } as unknown as AIProvider), getModelInfo: () => undefined } as unknown as ProviderManager, (event) => events.push(event))
    try {
      const c = comment('k', 'a'.repeat(40))
      await expect(fresh.sendReviewComments('c1', [c])).rejects.toThrow('Choose a model')
      mocks.conversation = { providerId: 'p', model: 'task-model' }
      const { streamId } = await fresh.sendReviewComments('c1', [c])
      await settled(streamId)
      expect(requests.at(-1)!.model).toBe('task-model')
    } finally {
      fresh.cancelAll()
      fresh.dispose()
    }
  })

  it('refuses while a turn is running, and without a folder', async () => {
    await editedTask()
    script = [[{ id: 'w', name: 'write_file', input: { path: 'new.txt', content: 'x' } }]]
    step = 0
    await service.start({ streamId: 'busy', conversationId: 'c1', userText: 'again', fileToolsEnabled: true, permissionMode: 'default', policy })
    await vi.waitFor(() => expect(events.some((e) => e.streamId === 'busy' && e.kind === 'permission')).toBe(true), { timeout: 8000 })
    await expect(service.sendReviewComments('c1', [comment('k', 'a'.repeat(40))])).rejects.toThrow('already has a running turn')
    const ask = events.find((e) => e.streamId === 'busy' && e.kind === 'permission')
    if (ask?.kind === 'permission') service.resolvePermission(ask.ask.id, 'deny')
    await settled('busy')
    await expect(service.sendReviewComments('missing', [comment('k', 'a'.repeat(40))])).rejects.toThrow('Task was not found.')
    mocks.workspace = ''
    await expect(service.sendReviewComments('c1', [comment('k', 'a'.repeat(40))])).rejects.toThrow('no workspace folder')
  })

  it('still sends a comment whose hunk is gone, and says the quote is missing', async () => {
    await editedTask()
    const [review] = await service.getReview('c1', { kind: 'session' })
    await service.revertHunks('c1', { path: 'a.txt', hunkIds: [review!.hunks[0]!.id], expectHeadHash: review!.headHash! })
    const { text, streamId } = await service.sendReviewComments('c1', [comment('k', review!.hunks[0]!.id)])
    await settled(streamId)
    expect(text).toContain('1. Line 6\nThat part of the diff has changed since the comment was written, so no code is quoted.\nWhy this wording?')
  })
})
