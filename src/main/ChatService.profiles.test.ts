import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: undefined as string | undefined, profile: undefined as string | undefined }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: () => ({ id: 'task', messages: [], workspacePath: mocks.workspace }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {}, mcpServers: [], hooks: [], ai: { harnessProfile: mocks.profile } }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

let service: ChatService | undefined
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-chat-profiles-'))
  mocks.workspace = join(mocks.dataRoot, 'project')
  mkdirSync(mocks.workspace)
  mocks.profile = undefined
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

function request(model: string, extra: Partial<ChatStartRequest> = {}, params?: { temperature: number }): ChatStartRequest {
  return {
    streamId: 'profile-stream', conversationId: 'task', userText: 'Rename the helper in src/util.ts.',
    fileToolsEnabled: true, subagentEnabled: true,
    policy: { primary: { providerId: 'fixture', model, ...(params ? { params } : {}) }, fallbacks: [], fallbackEnabled: false,
      retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} },
    ...extra
  }
}

async function first(req: ChatStartRequest): Promise<AIRequest> {
  const requests: AIRequest[] = []
  const events: ChatEvent[] = []
  const provider = { id: 'fixture', async *streamMessage(input: AIRequest): AsyncGenerator<AIStreamEvent> {
    requests.push(structuredClone(input))
    yield { type: 'text_delta', text: 'Done.' }
    yield { type: 'stop', stopReason: 'stop' }
  } } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => { events.push(event) })
  await service.start(req)
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
  return requests[0]!
}

const names = (sent: AIRequest): string[] => (sent.tools ?? []).map((tool) => tool.name)

describe('the tools a turn offers by model profile', () => {
  it('gives a Claude model edit_file and multi_edit but not apply_patch, with the whole rest of the set', async () => {
    const sent = await first(request('claude-sonnet-4-5'))
    expect(names(sent)).toEqual(expect.arrayContaining(['edit_file', 'multi_edit', 'write_file', 'remove_file', 'git_commit', 'git_log', 'delegate_to_subagent', 'skill']))
    expect(names(sent)).not.toContain('apply_patch')
    expect(sent.system).toContain('Use multi_edit')
    expect(sent.params?.temperature).toBeUndefined()
  })

  it('gives a GPT-5 model apply_patch instead of edit_file and multi_edit', async () => {
    const sent = await first(request('gpt-5-codex'))
    expect(names(sent)).toContain('apply_patch')
    expect(names(sent)).toEqual(expect.arrayContaining(['write_file', 'remove_file']))
    expect(names(sent)).not.toContain('edit_file')
    expect(names(sent)).not.toContain('multi_edit')
    expect(sent.system).toContain('Use apply_patch')
    expect(sent.system).not.toContain('Use edit_file')
  })

  it('gives an open model the lean set and a prompt that lists exactly it', async () => {
    const full = await first(request('claude-sonnet-4-5'))
    const lean = await first(request('qwen3-coder'))
    for (const gone of ['multi_edit', 'apply_patch', 'git_commit', 'git_branch', 'git_log', 'git_show', 'git_blame', 'delegate_to_subagent', 'skill', 'task_input']) {
      expect(names(lean)).not.toContain(gone)
    }
    expect(names(lean)).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'write_file', 'remove_file', 'run_command', 'git_status', 'ask_user_question', 'todo_write']))
    for (const name of names(lean)) expect(lean.system).toContain(`- ${name}\n`)
    expect(lean.system).not.toContain('delegate_to_subagent')
    expect(lean.system).toContain('Call one tool at a time')
    expect(String(lean.system).length).toBeLessThan(String(full.system).length)
    expect(lean.params?.temperature).toBe(0.7)
  })

  it('keeps the skill tool for a lean model when the message names a skill', async () => {
    const sent = await first(request('qwen3-coder', { userText: 'Use $frontend-engineering to improve this screen.' }))
    expect(names(sent)).toContain('skill')
    expect(sent.system).toContain('Call skill only when the user names one')
  })

  it('keeps plan mode, ask_user_question and the goal tool on a lean model', async () => {
    const plan = await first(request('qwen3-coder', { permissionMode: 'plan' }))
    expect(names(plan)).toContain('exit_plan_mode')
    expect(plan.system).toContain('Submit the full Markdown plan with exit_plan_mode')
    await service?.cancelAll()
    service?.dispose()
    const goal = await first(request('qwen3-coder', { goal: { text: 'Make the build pass.' } }))
    expect(names(goal)).toEqual(expect.arrayContaining(['goal_update', 'ask_user_question']))
  })

  it('lets the setting apply one profile to every model', async () => {
    mocks.profile = 'lean'
    expect(names(await first(request('claude-sonnet-4-5')))).not.toContain('git_commit')
    service?.dispose()
    mocks.profile = 'full'
    expect(names(await first(request('qwen3-coder')))).toContain('git_commit')
  })

  it('does not replace a temperature the person set', async () => {
    const sent = await first(request('qwen3-coder', {}, { temperature: 0.2 }))
    expect(sent.params?.temperature).toBe(0.2)
  })
})
