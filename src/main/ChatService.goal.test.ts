import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIResponse, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'
import { removeFolder } from './testing/removeFolder'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '', usage: [] as unknown[], judge: '{"met": true, "reason": "The record shows the tests passed."}' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) }
}))
vi.mock('./config', () => ({
  getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], privacy: { localOnly: false }, shell: { preferred: 'auto' } })
}))
vi.mock('./cost', () => ({ recordUsage: (usage: unknown) => { mocks.usage.push(usage) } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-goal-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.usage = []
  mocks.judge = '{"met": true, "reason": "The record shows the tests passed."}'
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
  writeFileSync(join(mocks.workspace, 'notes.txt'), 'hello')
})
afterEach(async () => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  await removeFolder(root)
})

const policy = { primary: { providerId: 'p', model: 'm', params: { reasoningEffort: 'high' as const } }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

function harness() {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  const judged: AIRequest[] = []
  let steps: Step[] = []
  let used = 0
  let turns = 0
  const provider = {
    id: 'p', name: 'Provider',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(request)
      const step = steps[used++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    },
    // The model that judges a goal is asked with a plain request.
    async sendMessage(request: AIRequest): Promise<AIResponse> {
      judged.push(request)
      return { id: 'r', provider: 'p', model: 'm', content: [], text: mocks.judge, toolCalls: [], stopReason: 'stop', createdAt: 0, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } as unknown as AIResponse
    }
  } as unknown as AIProvider
  const service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => { events.push(event) })
  services.push(service)
  return {
    service, requests, judged, events,
    async turn(turnSteps: Step[], goal?: ChatStartRequest['goal'], conversationId = 'c1') {
      steps = turnSteps; used = 0
      const from = events.length
      const request: ChatStartRequest = {
        streamId: `s${++turns}`, conversationId, messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: 'default', policy,
        ...(goal ? { goal } : {})
      }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 10_000 })
      // The record of the turn is written as it is retired.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return events.slice(from)
    }
  }
}

const toolNames = (request: AIRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name)
const call = (name: string, input: Record<string, unknown>, id = 'k1'): ToolCall => ({ id, name, input } as ToolCall)
const node = (script: string): string => `node -e "${script}"`

describe('offering goal_update', () => {
  it('offers the tool and the goal section of the prompt only while a goal is active', async () => {
    const h = harness()
    await h.turn(['hello'])
    expect(toolNames(h.requests[0])).not.toContain('goal_update')
    expect(String(h.requests[0]!.system)).not.toContain('## Goal')

    await h.turn(['hello'], { text: 'all tests in packages/api pass' })
    expect(toolNames(h.requests[1])).toContain('goal_update')
    const system = String(h.requests[1]!.system)
    expect(system).toContain('## Goal')
    expect(system).toContain('all tests in packages/api pass')
    expect(system).not.toContain('Cubex also runs this command')
  })

  it('tells the agent about the check command, which it must make pass and not change', async () => {
    const h = harness()
    await h.turn(['hello'], { text: 'it builds', check: 'npm run build' })
    expect(String(h.requests[0]!.system)).toContain('Cubex also runs this command after every turn: npm run build')
  })

  it('ignores a goal that is not one', async () => {
    const h = harness()
    await h.turn(['hello'], { text: '' } as never)
    await h.turn(['hello'], { text: 'x'.repeat(5000) })
    await h.turn(['hello'], 'all tests pass' as never)
    for (const request of h.requests) expect(toolNames(request)).not.toContain('goal_update')
  })
})

describe('what the agent says about the goal', () => {
  it('reaches the window as an event, and the turn goes on to its closing words', async () => {
    const h = harness()
    const events = await h.turn([[call('goal_update', { status: 'complete', note: 'ran npm test: 12 passed' }, 'g1')], 'All 12 tests pass.'], { text: 'tests pass' })
    const claims = events.flatMap((e) => (e.kind === 'goal' ? [e.claim] : []))
    expect(claims).toEqual([{ status: 'complete', note: 'ran npm test: 12 passed' }])
    expect(h.requests).toHaveLength(2)
    expect(JSON.stringify(h.requests[1]!.messages)).toContain('Cubex will now check the goal')
    const done = events.flatMap((e) => (e.kind === 'tool' && e.tool.id === 'g1' ? [e.tool] : [])).at(-1)
    expect(done?.phase).toBe('done')
  })

  it('does not raise a claim for a call that was refused', async () => {
    const h = harness()
    const events = await h.turn([[call('goal_update', { status: 'complete', note: '  ' }, 'g1')], 'ok'], { text: 'tests pass' })
    expect(events.some((e) => e.kind === 'goal')).toBe(false)
  })
})

describe('judging a turn', () => {
  it('is met when the check command exits with 0, and goes on with its output when it does not', async () => {
    const h = harness()
    const met = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'tests pass', check: node("console.log('12 passed')") } })
    expect(met.kind).toBe('met')
    const failing = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'tests pass', check: node("console.log('FAIL a.test.ts'); process.exit(1)") } })
    expect(failing).toMatchObject({ kind: 'continue', reason: expect.stringContaining('exit code 1') })
    expect(failing.kind === 'continue' && failing.detail).toContain('FAIL a.test.ts')
  })

  it('runs the check in the task\'s folder', async () => {
    const h = harness()
    const verdict = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'notes exist', check: node("process.exit(require('fs').existsSync('notes.txt') ? 0 : 1)") } })
    expect(verdict.kind).toBe('met')
  })

  it('asks the model the task uses, with the record of the turn, when the agent says the goal is met', async () => {
    const h = harness()
    await h.turn([[call('read_file', { path: 'notes.txt' }, 'r1')], 'Read the notes.'], { text: 'notes are read' })
    const verdict = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'notes are read' }, claim: { status: 'complete', note: 'read notes.txt' } })
    expect(verdict).toEqual({ kind: 'met', reason: 'The record shows the tests passed.' })
    expect(h.judged).toHaveLength(1)
    const asked = h.judged[0]!
    const prompt = JSON.stringify(asked.messages)
    expect(prompt).toContain('<goal>')
    expect(prompt).toContain('read_file')
    expect(String(asked.system)).toContain('You decide whether a goal has been met')
    // No tools, and not the effort the task was using.
    expect(asked.tools).toBeUndefined()
    expect(JSON.stringify(asked.params ?? {})).not.toContain('reasoningEffort')
    // The judge is a paid request like any other: it counts in the usage.
    expect(mocks.usage.length).toBeGreaterThan(0)
  })

  it('goes on, without asking a model, when the agent said nothing about the goal', async () => {
    const h = harness()
    const verdict = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'tests pass' } })
    expect(verdict).toMatchObject({ kind: 'continue' })
    expect(h.judged).toHaveLength(0)
  })

  it('pauses (an error) when the model that judges answers in a form it cannot read', async () => {
    const h = harness()
    mocks.judge = 'Sure, looks done to me.'
    const verdict = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g' }, claim: { status: 'complete', note: 'done' } })
    expect(verdict.kind).toBe('error')
  })

  it('stops the check when the goal is paused', async () => {
    const h = harness()
    const pending = h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g', check: node('setInterval(() => {}, 1000)') } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    h.service.cancelGoalCheck('c1')
    const verdict = await pending
    expect(verdict).toMatchObject({ kind: 'error', reason: 'The check was cancelled.' })
  }, 20_000)

  it('counts a goal that is being checked, so the computer can be kept awake for it', async () => {
    const h = harness()
    expect(h.service.runningGoalChecks).toBe(0)
    const pending = h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g', check: node('setInterval(() => {}, 1000)') } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.service.runningGoalChecks).toBe(1)
    h.service.cancelGoalCheck('c1')
    await pending
    expect(h.service.runningGoalChecks).toBe(0)
    // A check that finishes on its own leaves nothing behind either.
    await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g', check: node('process.exit(0)') } })
    expect(h.service.runningGoalChecks).toBe(0)
  }, 20_000)

  it('lets a new request for a task replace the one still running', async () => {
    const h = harness()
    const first = h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g', check: node('setInterval(() => {}, 1000)') } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await h.service.evaluateGoal({ conversationId: 'c1', goal: { text: 'g', check: node('process.exit(0)') } })
    expect(second.kind).toBe('met')
    expect(await first).toMatchObject({ kind: 'error' })
  }, 20_000)
})
