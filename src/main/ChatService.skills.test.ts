import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: undefined as string | undefined, selected: undefined as string | undefined }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: () => ({ id: 'task', messages: [], workspacePath: mocks.workspace }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.selected }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'
import { loadSkills, readSkill } from './skills'

let service: ChatService | undefined
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-chat-skills-'))
  mocks.workspace = undefined
  mocks.selected = undefined
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

function request(): ChatStartRequest {
  return {
    streamId: 'skill-stream', conversationId: 'task', userText: 'Use $frontend-engineering to improve this screen.',
    fileToolsEnabled: true,
    policy: { primary: { providerId: 'fixture', model: 'fixture' }, fallbacks: [], fallbackEnabled: false,
      retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}

async function run(req: ChatStartRequest, useSkill = true): Promise<{ requests: AIRequest[]; events: ChatEvent[] }> {
  const requests: AIRequest[] = []
  const events: ChatEvent[] = []
  const provider = { id: 'fixture', async *streamMessage(input: AIRequest): AsyncGenerator<AIStreamEvent> {
    requests.push(structuredClone(input))
    if (useSkill && requests.length === 1) {
      yield { type: 'tool_call', toolCall: { id: 'load-frontend', name: 'skill', input: { name: 'frontend-engineering' } } }
      yield { type: 'stop', stopReason: 'tool_use' }
    } else {
      yield { type: 'text_delta', text: 'Review complete.' }
      yield { type: 'stop', stopReason: 'stop' }
    }
  } } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager,
    (event) => { events.push(event) })
  await service.start(req)
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
  return { requests, events }
}

describe('skill discovery and on-demand instructions in real chat requests', () => {
  it('offers bundled skills without a workspace and loads a body only when called', async () => {
    const frontend = loadSkills().find((skill) => skill.name === 'frontend-engineering')!
    expect(frontend).toBeDefined()
    const body = readSkill(frontend)
    const { requests, events } = await run(request())
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools?.some((tool) => tool.name === 'skill')).toBe(true)
    expect(requests[0]!.system).toContain(frontend.description)
    expect(JSON.stringify(requests[0])).not.toContain(body)
    const loaded = requests[1]!.messages.flatMap((message) => message.content)
      .find((part) => part.type === 'tool_result' && part.toolUseId === 'load-frontend')
    expect(loaded?.type === 'tool_result' && JSON.stringify(loaded.content)).toContain(JSON.stringify(body).slice(1, -1))
    expect(events.some((event) => event.kind === 'tool' && event.tool.name === 'skill' && event.tool.phase === 'done')).toBe(true)
    const contexts = events.filter((event) => event.kind === 'context').map((event) => event.context)
    expect(contexts[0]!.sections.find((section) => section.id === 'system')?.details?.some((detail) => detail.id === 'skills')).toBe(true)
    expect(contexts.at(-1)!.sections.find((section) => section.id === 'toolResults')!.estimatedTokens).toBeGreaterThan(0)
  })

  it('uses the task project override rather than another selected folder', async () => {
    const fixture = (root: string, marker: string): void => {
      const dir = join(root, '.cubex', 'skills', 'frontend-engineering')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: frontend-engineering\ndescription: ${marker} project design.\n---\n${marker} body: preserve this project navigation.\n`)
    }
    mocks.workspace = join(mocks.dataRoot, 'task-project')
    mocks.selected = join(mocks.dataRoot, 'other-project')
    fixture(mocks.workspace, 'OWNED_SKILL')
    fixture(mocks.selected, 'FOREIGN_SKILL')
    const { requests } = await run(request())
    expect(requests[0]!.system).toContain('OWNED_SKILL project design')
    expect(requests[0]!.system).not.toContain('OWNED_SKILL body')
    expect(JSON.stringify(requests)).not.toContain('FOREIGN_SKILL')
    expect(JSON.stringify(requests[1]!.messages)).toContain('OWNED_SKILL body')
  })

  it('keeps guidance loading read-only in plan mode', async () => {
    const { requests, events } = await run({ ...request(), permissionMode: 'plan' })
    expect(requests[1]!.system).toContain('## Active mode: PLAN')
    expect(events.some((event) => event.kind === 'permission')).toBe(false)
    expect(events.some((event) => event.kind === 'mode')).toBe(false)
    expect(events.some((event) => event.kind === 'tool' && event.tool.name === 'skill' && event.tool.phase === 'done')).toBe(true)
  })

  it('does not add instructions or a skill tool to an ordinary tool-free conversation', async () => {
    const { requests } = await run({ ...request(), fileToolsEnabled: false }, false)
    expect(requests[0]!.tools?.some((tool) => tool.name === 'skill')).toBeFalsy()
    expect(requests[0]!.system).not.toContain('## Available skills')
  })
})
