import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ModelInfo } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
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
  const output = resolve('out')
  mkdirSync(output, { recursive: true })
  fixtureRoot = mkdtempSync(join(output, 'cubex-identity-test-'))
  mocks.dataRoot = join(fixtureRoot, 'data')
  mocks.workspace = join(fixtureRoot, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function systemPromptFor(model: string, info?: Partial<ModelInfo>): Promise<string> {
  const events: ChatEvent[] = []
  let system = ''
  const provider = {
    id: 'primary',
    streamMessage: async function* (req: AIRequest): AsyncGenerator<AIStreamEvent> {
      system = typeof req.system === 'string' ? req.system : ''
      yield { type: 'text_delta', text: 'ok' }
    }
  } as unknown as AIProvider
  const manager = { resolve: (id: string) => id === 'primary' ? provider : undefined, getModelInfo: () => info as ModelInfo | undefined } as unknown as ProviderManager
  service = new ChatService(manager, (event) => { events.push(event) })
  const request: ChatStartRequest = {
    streamId: 's1', conversationId: 'task-one', messageId: 'u1', userText: 'Who are you?', fileToolsEnabled: true, permissionMode: 'default',
    policy: { primary: { providerId: 'primary', model }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
  await service.start(request)
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && e.event.type === 'completed')).toBe(true), { timeout: 5_000 })
  return system
}

describe('the model keeps its own identity in a turn', () => {
  it('is told the name the picker shows and its maker, never that it is Cubex', async () => {
    const system = await systemPromptFor('claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5' })
    expect(system.startsWith('You are Claude Sonnet 5.5 (model id claude-sonnet-5-5), made by Anthropic, working with the user inside Cubex')).toBe(true)
    expect(system).not.toMatch(/You are Cubex/)
  })

  it('works from the id alone when the provider listed nothing about the model', async () => {
    const system = await systemPromptFor('moonshotai/kimi-k3')
    expect(system.startsWith('You are moonshotai/kimi-k3, made by Moonshot AI, working with the user inside Cubex')).toBe(true)
  })
})
