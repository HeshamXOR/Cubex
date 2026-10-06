import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIStreamEvent, ExecutableTool, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'
import { commitCount, git, hasGit, initRepo, porcelain, seedHistory, write } from './tools/gitTestHelpers'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('./mcp/McpManager', () => {
  class McpManager {
    static describe(): string | undefined { return undefined }
    async getTools(): Promise<ExecutableTool[]> { return [] }
    disposeAll(): void {}
  }
  return { McpManager }
})

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-chat-git-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
  if (hasGit) {
    initRepo(mocks.workspace)
    seedHistory(mocks.workspace)
  }
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

/** A ChatService over a scripted model; permission asks are answered from `answers` in order (default deny). */
function harness() {
  const events: ChatEvent[] = []
  let script: Step[] = []
  let requests = 0
  let answers: PermissionDecision[] = []
  let turns = 0
  const provider = {
    id: 'p',
    async *streamMessage(): AsyncGenerator<AIStreamEvent> {
      const step = script[requests++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') {
      const decision = answers.shift() ?? 'deny'
      queueMicrotask(() => service.resolvePermission(event.ask.id, decision))
    }
  })
  services.push(service)
  return {
    service,
    async turn(steps: Step[], mode: PermissionMode = 'default', turnAnswers: PermissionDecision[] = []): Promise<ChatEvent[]> {
      script = steps; requests = 0; answers = [...turnAnswers]
      const from = events.length
      const request: ChatStartRequest = {
        streamId: `s${++turns}`, conversationId: 'c1', messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy
      }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 15_000 })
      return events.slice(from)
    }
  }
}

const asks = (events: ChatEvent[]): PermissionAsk[] => events.flatMap((e) => (e.kind === 'permission' ? [e.ask] : []))
const tool = (events: ChatEvent[], id: string): Array<{ phase: string; title?: string; detail?: string }> =>
  events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [{ phase: e.tool.phase, title: e.tool.title, detail: e.tool.detail }] : []))
const call = (id: string, name: string, input: ToolCall['input'] = {}): ToolCall => ({ id, name, input })
const commit = (id: string): ToolCall => call(id, 'git_commit', { message: 'Update a\n\nWith a body.', paths: ['a.txt'] })
const branch = (id: string): ToolCall => call(id, 'git_branch', { name: 'feature/x' })

describe.skipIf(!hasGit)('git tools in the agent loop', { timeout: 60_000 }, () => {
  it('runs the read-only tools without asking, in every permission mode including plan', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypass'] as PermissionMode[]) {
      const events = await app.turn([[
        call('s', 'git_status'), call('d', 'git_diff'), call('l', 'git_log', { max: 3 }),
        call('w', 'git_show', { rev: 'HEAD' }), call('b', 'git_blame', { path: 'a.txt' })
      ]], mode)
      expect(asks(events), mode).toEqual([])
      for (const id of ['s', 'd', 'l', 'w', 'b']) expect(tool(events, id).map((entry) => entry.phase), `${mode} ${id}`).toEqual(['running', 'done'])
    }
  })

  it('asks before committing, shows the subject, and offers no always-allow rule', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const before = commitCount(mocks.workspace)

    const denied = await app.turn([[commit('c1')]], 'default', ['deny'])
    expect(asks(denied)).toHaveLength(1)
    expect(asks(denied)[0]!.title).toBe('Commit: Update a (a.txt)')
    expect(asks(denied)[0]!.rule).toBeUndefined()
    expect(asks(denied)[0]!.detail).toContain('Update a')
    expect(tool(denied, 'c1').map((entry) => entry.phase)).toEqual(['running', 'error'])
    expect(commitCount(mocks.workspace)).toBe(before)

    // "Always" is accepted for this call but never turns into a rule, so the next commit asks again.
    const always = await app.turn([[commit('c2')]], 'default', ['always'])
    expect(asks(always)).toHaveLength(1)
    expect(tool(always, 'c2').map((entry) => entry.phase)).toEqual(['running', 'done'])
    expect(commitCount(mocks.workspace)).toBe(before + 1)
    expect(app.service.listPermissionRules()).toEqual([])

    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n')
    const again = await app.turn([[commit('c3')]], 'default', ['allow'])
    expect(asks(again)).toHaveLength(1)
    expect(commitCount(mocks.workspace)).toBe(before + 2)
  })

  it('says in the approval title what an unscoped commit will include', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const events = await app.turn([[call('c1', 'git_commit', { message: 'Everything' }), call('c2', 'git_commit', { message: 'Some', paths: ['a.txt', 'b.txt', 'c.txt'] })]], 'default', ['deny', 'deny'])
    expect(asks(events).map((ask) => ask.title)).toEqual(['Commit: Everything (all tracked changes)', 'Commit: Some (3 files)'])
  })

  it('asks before creating a branch', async () => {
    const app = harness()
    const denied = await app.turn([[branch('b1')]], 'default', ['deny'])
    expect(asks(denied)).toHaveLength(1)
    expect(asks(denied)[0]!.title).toBe('Create branch feature/x')
    expect(asks(denied)[0]!.rule).toBeUndefined()
    expect(git(mocks.workspace, 'branch', '--list', 'feature/x').trim()).toBe('')
    const allowed = await app.turn([[branch('b2')]], 'default', ['allow'])
    expect(tool(allowed, 'b2').map((entry) => entry.phase)).toEqual(['running', 'done'])
    expect(git(mocks.workspace, 'branch', '--list', 'feature/x')).toContain('feature/x')
  })

  it('blocks both mutating tools in plan mode without asking', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const before = commitCount(mocks.workspace)
    const events = await app.turn([[commit('c1'), branch('b1')]], 'plan')
    expect(asks(events)).toEqual([])
    for (const id of ['c1', 'b1']) {
      const entries = tool(events, id)
      expect(entries.at(-1)).toMatchObject({ phase: 'error', detail: 'Blocked in plan mode' })
    }
    expect(commitCount(mocks.workspace)).toBe(before)
    expect(git(mocks.workspace, 'branch', '--list', 'feature/x').trim()).toBe('')
    expect(porcelain(mocks.workspace)).toEqual([' M a.txt'])
  })

  it('still asks in acceptEdits mode, because a commit is not an edit', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const events = await app.turn([[commit('c1')]], 'acceptEdits', ['allow'])
    expect(asks(events)).toHaveLength(1)
    expect(tool(events, 'c1').map((entry) => entry.phase)).toEqual(['running', 'done'])
  })

  it('runs without asking only when the user chose to bypass approvals', async () => {
    const app = harness()
    write(mocks.workspace, 'a.txt', 'one\ntwo\nthree\nfour\n')
    const before = commitCount(mocks.workspace)
    const events = await app.turn([[commit('c1'), branch('b1')]], 'bypass')
    expect(asks(events)).toEqual([])
    expect(commitCount(mocks.workspace)).toBe(before + 1)
    expect(git(mocks.workspace, 'branch', '--list', 'feature/x')).toContain('feature/x')
  })
})
