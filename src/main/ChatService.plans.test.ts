import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AIRequest, AIResponse, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'
import { DEFAULT_RETRY_POLICY } from '@core/types'

const mocks = vi.hoisted(() => ({
  dataRoot: '', requests: [] as AIRequest[], responses: [] as AIResponse[], workspace: undefined as string | undefined,
  childRequests: [] as AIRequest[], childResponses: [] as AIResponse[], childSignal: undefined as AbortSignal | undefined,
  stallChild: false, usage: vi.fn()
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: () => ({ id: 'task', messages: [], workspacePath: mocks.workspace }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: 'different-global-project' }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: mocks.usage }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('@core/gateway', async () => ({
  AIGateway: class {
    async *stream(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      mocks.requests.push(structuredClone(request))
      const response = mocks.responses.shift()
      if (!response) throw new Error('Unexpected extra model request')
      yield { type: 'completed', response }
    }
    async send(request: AIRequest, _policy: unknown, options: { signal?: AbortSignal }): Promise<AIResponse> {
      mocks.childRequests.push(structuredClone(request))
      mocks.childSignal = options.signal
      if (mocks.stallChild) return new Promise(() => {})
      const response = mocks.childResponses.shift()
      if (!response) throw new Error('Unexpected extra child request')
      return response
    }
  },
  createSubagentTool: (await vi.importActual<typeof import('@core/gateway')>('@core/gateway')).createSubagentTool
}))

import { ChatService } from './ChatService'
import { PlanStore } from './plans'

function response(toolCalls: ToolCall[] = []): AIResponse {
  return { id: 'response', provider: 'test', model: 'test', content: [], text: toolCalls.length ? '' : 'Done', toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'stop', createdAt: Date.now() }
}
const planCall = (plan = '# Plan\n\n1. Fix the parser.'): ToolCall => ({ id: `call-${Math.random()}`, name: 'exit_plan_mode', input: { plan } })
const request = (): ChatStartRequest => ({
  streamId: 'renderer-allocated-stream', conversationId: 'task', userText: 'Fix the parser', permissionMode: 'plan',
  systemPrompt: 'Keep comments intact.',
  policy: { primary: { providerId: 'test', model: 'test' }, fallbackEnabled: false, fallbacks: [], retry: DEFAULT_RETRY_POLICY, timeout: {} }
})
let service: ChatService | undefined
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-plan-chat-'))
  mocks.requests.length = 0
  mocks.responses.length = 0
  mocks.workspace = undefined
  mocks.childRequests.length = 0
  mocks.childResponses.length = 0
  mocks.childSignal = undefined
  mocks.stallChild = false
  mocks.usage.mockClear()
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

describe('ChatService plan transitions', () => {
  it('rebuilds the system prompt after approval and preserves user configuration', async () => {
    const events: ChatEvent[] = []
    mocks.responses.push(response([planCall()]), response())
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => {
      events.push(event)
      if (event.kind === 'plan') service!.resolvePlan(event.ask.id, 'acceptEdits')
    })
    await expect(service.start(request())).resolves.toEqual({ streamId: 'renderer-allocated-stream' })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.requests).toHaveLength(2)
    expect(mocks.requests[0]?.system).toContain('## Active mode: PLAN')
    expect(mocks.requests[0]?.tools?.some((tool) => tool.name === 'read_plan')).toBe(false)
    expect(mocks.requests[1]?.system).toContain('## Active mode: acceptEdits')
    expect(mocks.requests[1]?.system).not.toContain('## Active mode: PLAN')
    expect(mocks.requests[1]?.system).toContain('Keep comments intact.')
    expect(mocks.requests[1]?.system).not.toContain('different-global-project')
    expect(service.listPlans('task')[0]?.status).toBe('approved')
  })

  it('returns exact rejection feedback while retaining plan restrictions for the next request', async () => {
    const feedback = '  No wrapper.\nKeep the current exported function.  '
    const events: ChatEvent[] = []
    mocks.responses.push(response([planCall()]), response())
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => {
      events.push(event)
      if (event.kind === 'plan') service!.resolvePlan(event.ask.id, 'reject', feedback)
    })
    await service.start(request())
    await vi.waitFor(() => expect(mocks.requests).toHaveLength(2))
    expect(mocks.requests[1]?.system).toContain('## Active mode: PLAN')
    const toolMessage = mocks.requests[1]?.messages.at(-1)
    expect(JSON.stringify(toolMessage)).toContain(JSON.stringify(feedback).slice(1, -1))
    expect(events.filter((event) => event.kind === 'mode')).toHaveLength(0)
    expect(service.listPlans('task')[0]?.status).toBe('rejected')
    expect(events.some((event) => event.kind === 'tool' && event.tool.name === 'exit_plan_mode' && event.tool.title === 'Plan needs revision' && event.tool.phase === 'done')).toBe(true)
    expect(JSON.stringify(toolMessage)).toContain('"isError":true')
  })

  it('cancels pending approval without starting implementation or a new model request', async () => {
    const events: ChatEvent[] = []
    mocks.responses.push(response([planCall()]))
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => {
      events.push(event)
      if (event.kind === 'plan') service!.cancel(event.streamId)
    })
    await service.start(request())
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.requests).toHaveLength(1)
    expect(service.listPlans('task')[0]?.status).toBe('cancelled')
    expect(events.filter((event) => event.kind === 'mode')).toHaveLength(0)
  })

  it('rejects duplicate active stream ids and malformed renderer ids', async () => {
    mocks.responses.push(response([planCall()]))
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, () => {})
    await service.start(request())
    await expect(service.start(request())).rejects.toThrow('already running')
    await expect(service.start({ ...request(), streamId: '../../bad' })).rejects.toThrow('Invalid stream id')
    service.cancelAll()
    await vi.waitFor(() => expect(service!.listPlans('task')[0]?.status).toBe('cancelled'))
  })

  it('does not execute writes authored before plan approval in the same tool batch', async () => {
    mocks.workspace = join(mocks.dataRoot, 'project')
    mkdirSync(mocks.workspace)
    const events: ChatEvent[] = []
    mocks.responses.push(response([
      planCall(),
      { id: 'premature-write', name: 'write_file', input: { path: 'premature.txt', content: 'must not write' } }
    ]), response())
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => {
      events.push(event)
      if (event.kind === 'plan') service!.resolvePlan(event.ask.id, 'acceptEdits')
    })
    await service.start({ ...request(), fileToolsEnabled: true })
    await vi.waitFor(() => expect(mocks.requests).toHaveLength(2))
    expect(existsSync(join(mocks.workspace, 'premature.txt'))).toBe(false)
    expect(events.some((event) => event.kind === 'tool' && event.tool.id === 'premature-write' && event.tool.detail === 'Blocked in plan mode')).toBe(true)
    expect(mocks.requests[1]?.system).toContain('## Active mode: acceptEdits')
  })

  it('allows a plan review at the iteration limit and gives implementation a fresh budget', async () => {
    const events: ChatEvent[] = []
    // Invalid submissions exercise recovery without requiring external tools.
    for (let index = 0; index < 11; index++) mocks.responses.push(response([planCall('')]))
    mocks.responses.push(response([planCall()]), response())
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => {
      events.push(event)
      if (event.kind === 'plan') service!.resolvePlan(event.ask.id, 'default')
    })
    await service.start(request())
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.requests).toHaveLength(13)
    expect(mocks.requests[12]?.system).toContain('## Active mode: default')
    expect(service.listPlans('task')).toHaveLength(1)
  })

  it('offers persisted plans on later turns through a bounded catalog and task-specific tool', async () => {
    const previousProcess = new PlanStore(join(mocks.dataRoot, 'plans'))
    const saved = Array.from({ length: 12 }, (_, index) => {
      const plan = previousProcess.create('task', { title: `Revision ${index}`, plan: `# PLAN_BODY_${index}\n\n1. Preserve the parser.` })
      previousProcess.settle(plan.id, { decision: 'reject', feedback: `Feedback ${index}` })
      return plan
    })
    const foreign = previousProcess.create('other-task', { plan: '# FOREIGN_PLAN_BODY' })
    previousProcess.settle(foreign.id, { decision: 'default' })
    const events: ChatEvent[] = []
    mocks.responses.push(response([{ id: 'read-plan', name: 'read_plan', input: {} }]), response())
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => { events.push(event) })
    await service.start(request())
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.requests[0]?.tools?.some((tool) => tool.name === 'read_plan')).toBe(true)
    expect(mocks.requests[0]?.system).toContain(saved[11]!.id)
    expect(mocks.requests[0]?.system).toContain(saved[2]!.id)
    expect(mocks.requests[0]?.system).not.toContain(saved[1]!.id)
    expect(mocks.requests[0]?.system).not.toContain('PLAN_BODY_')
    expect(mocks.requests[0]?.system).not.toContain(foreign.id)
    expect(JSON.stringify(mocks.requests[1]?.messages.at(-1))).toContain('PLAN_BODY_11')
    expect(JSON.stringify(mocks.requests[1]?.messages.at(-1))).toContain('Feedback 11')
    expect(mocks.requests[1]?.system).toContain('## Active mode: PLAN')
    expect(events.some((event) => event.kind === 'tool' && event.tool.title === 'Read saved plan')).toBe(true)
  })

  it('gives children real task-scoped reads without satisfying the parent write ledger or ending its stream', async () => {
    mocks.workspace = join(mocks.dataRoot, 'project')
    mkdirSync(mocks.workspace)
    writeFileSync(join(mocks.workspace, 'parser.ts'), 'export function parse() { return "task workspace" }')
    mocks.responses.push(
      response([{ id: 'delegate', name: 'delegate_to_subagent', input: { task: 'Read parser.ts and report its public API.' } }]),
      response([{ id: 'parent-write', name: 'write_file', input: { path: 'parser.ts', content: 'must not overwrite without a parent read' } }]),
      response()
    )
    mocks.childResponses.push(
      { ...response([{ id: 'read', name: 'read_file', input: { path: 'parser.ts' } }]), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { ...response(), text: 'parse is exported from parser.ts:1.' }
    )
    const events: ChatEvent[] = []
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => { events.push(event) })
    await service.start({ ...request(), permissionMode: 'acceptEdits', fileToolsEnabled: true, subagentEnabled: true })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.childRequests).toHaveLength(2)
    expect(mocks.childRequests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(['glob_files', 'list_files', 'read_file', 'search_files', 'skill'])
    expect(mocks.childRequests[0]?.system).toContain(mocks.workspace)
    expect(mocks.childRequests[0]?.system).not.toContain('different-global-project')
    expect(JSON.stringify(mocks.requests[1]?.messages)).toContain('task workspace')
    expect(readFileSync(join(mocks.workspace, 'parser.ts'), 'utf8')).toContain('task workspace')
    expect(events.some((event) => event.kind === 'tool' && event.tool.id === 'parent-write' && event.tool.phase === 'error')).toBe(true)
    expect(events.filter((event) => event.kind === 'stream' && event.event.type === 'completed')).toHaveLength(1)
    expect(events.some((event) => event.kind === 'tool' && event.tool.id.startsWith('subagent-') && event.tool.title === 'Subagent · Read parser.ts' && event.tool.phase === 'done')).toBe(true)
    expect(mocks.usage).toHaveBeenCalledOnce()
  })

  it('stops an active child when the parent is cancelled and leaves no subsequent parent request', async () => {
    mocks.stallChild = true
    mocks.responses.push(response([{ id: 'delegate', name: 'delegate_to_subagent', input: { task: 'Analyze the supplied context.' } }]))
    const events: ChatEvent[] = []
    service = new ChatService({ resolve: vi.fn(), getModelInfo: vi.fn() } as unknown as ProviderManager, (event) => { events.push(event) })
    await service.start({ ...request(), subagentEnabled: true })
    await vi.waitFor(() => expect(mocks.childRequests).toHaveLength(1))
    expect(mocks.childRequests[0]?.tools?.map((tool) => tool.name)).toEqual(['skill'])
    service.cancel('renderer-allocated-stream')
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
    expect(mocks.childSignal?.aborted).toBe(true)
    expect(mocks.requests).toHaveLength(1)
  })
})
