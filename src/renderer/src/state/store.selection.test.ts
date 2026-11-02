import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { ModelInfo, ProviderConfig } from '@core/types'

const bridge = vi.hoisted(() => ({
  api: {
    startChat: vi.fn(), listPlans: vi.fn(), getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(),
    cancelChat: vi.fn(), onChatEvent: vi.fn(), createConversation: vi.fn(), listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'

const NVIDIA: ProviderConfig = {
  id: 'nv', name: 'NVIDIA', kind: 'openai-compat', accessType: 'api', enabled: true, auth: { type: 'none' }, defaultModel: 'meta/llama-3.3-70b-instruct'
}

const listed = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id, providerId: 'nv', displayName: id, location: 'cloud', capabilities: ['text'], modalities: { input: ['text'], output: ['text'] },
  supportsTools: true, supportsStructuredOutput: false, supportsReasoning: false, ...overrides
})

// What NVIDIA's own listing leaves out and the catalog fills in: this model reasons and takes three levels.
const K3 = listed('moonshotai/kimi-k3', { supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'] })
const LLAMA = listed('meta/llama-3.3-70b-instruct')

const chat = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud', messages: [], ...overrides
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

let stored: Record<string, Conversation>
const live = () => useStore.getState()
const open = (id: string) => live().openConversation(id)

beforeEach(() => {
  vi.clearAllMocks()
  stored = {
    a: chat('a', { providerId: 'nv', model: K3.id, composer: { effort: 'max', longContext: false, maxTokens: 8192 } }),
    b: chat('b', { providerId: 'nv', model: LLAMA.id, composer: { longContext: true, maxTokens: 2048 } })
  }
  bridge.api.onChatEvent.mockReturnValue(() => undefined)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.getConversation.mockImplementation(async (id: string) => stored[id])
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.listModels.mockResolvedValue([K3, LLAMA])
  bridge.api.listProviders.mockResolvedValue([NVIDIA])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  bridge.api.createConversation.mockImplementation(async (partial: Partial<Conversation>) => chat('new', partial))
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ settings: DEFAULT_SETTINGS, providers: [NVIDIA], models: { nv: [K3, LLAMA] } })
})

describe('each task keeps its own model and settings', () => {
  it('opens every task on the model, effort and limits it was last used with', async () => {
    await open('a')
    expect(live()).toMatchObject({ activeProviderId: 'nv', activeModel: K3.id, effort: 'max', longContext: false, maxTokens: 8192 })
    await open('b')
    expect(live()).toMatchObject({ activeProviderId: 'nv', activeModel: LLAMA.id, effort: undefined, longContext: true, maxTokens: 2048 })
    await open('a')
    expect(live()).toMatchObject({ activeModel: K3.id, effort: 'max', longContext: false, maxTokens: 8192 })
  })

  it('saves a model change to the open task only, and clears the effort the new model cannot take', async () => {
    await open('a')
    live().setActive('nv', LLAMA.id)
    expect(bridge.api.updateConversation).toHaveBeenCalledTimes(1)
    expect(bridge.api.updateConversation).toHaveBeenCalledWith('a', {
      providerId: 'nv', model: LLAMA.id, presetId: undefined, composer: { longContext: false, maxTokens: 8192 }
    })
    expect(live().activeConversation).toMatchObject({ id: 'a', model: LLAMA.id })
    expect(live().effort).toBeUndefined()
    // The other task was never written to, so it opens as it was left.
    await open('b')
    expect(live().activeModel).toBe(LLAMA.id)
    expect(bridge.api.updateConversation.mock.calls.every(([id]) => id === 'a')).toBe(true)
  })

  it('keeps an effort the model offers and moves one it does not to the nearest level', async () => {
    await open('a')
    live().setEffort('max')
    expect(live().effort).toBe('max')
    live().setEffort('medium')
    // Kimi K3 takes low, high and max: medium is as near to low as to high, and the lower one costs less.
    expect(live().effort).toBe('low')
  })

  it('leaves the composer alone for a task whose provider has since been removed or switched off', async () => {
    useStore.setState({ activeProviderId: 'nv', activeModel: K3.id, effort: 'high' })
    stored.gone = chat('gone', { providerId: 'removed', model: 'x', composer: { effort: 'low' } })
    await open('gone')
    expect(live()).toMatchObject({ activeProviderId: 'nv', activeModel: K3.id, effort: 'high' })

    useStore.setState({ providers: [{ ...NVIDIA, enabled: false }] })
    await open('a')
    expect(live()).toMatchObject({ activeProviderId: 'nv', activeModel: K3.id, effort: 'high' })
  })

})

describe('what a task reopens with while the model list is still loading', () => {
  it('takes its saved effort back once the model reports the levels it offers', async () => {
    useStore.setState({ models: {} })
    const gate = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValue(gate.promise)
    await open('a')
    // Only the id is known: a Kimi K3 is recognised as a reasoning model, but the level it takes is not yet.
    expect(live().activeModel).toBe(K3.id)
    expect(live().effort).toBe('high')
    gate.resolve([K3, LLAMA])
    await vi.waitFor(() => expect(live().effort).toBe('max'))
  })

  it("does not undo the person's own choice made while it loads", async () => {
    useStore.setState({ models: {} })
    const gate = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValue(gate.promise)
    await open('a')
    live().setEffort('low')
    gate.resolve([K3, LLAMA])
    await vi.waitFor(() => expect(live().models.nv).toHaveLength(2))
    expect(live().effort).toBe('low')
  })

  it("does not carry one task's late reply into another", async () => {
    useStore.setState({ models: {} })
    const gate = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValueOnce(gate.promise)
    await open('a')
    bridge.api.listModels.mockResolvedValue([K3, LLAMA])
    await open('b')
    gate.resolve([K3, LLAMA])
    await vi.waitFor(() => expect(live().models.nv).toHaveLength(2))
    expect(live()).toMatchObject({ activeModel: LLAMA.id, effort: undefined })
  })
})

describe('the permission mode is not part of what a task remembers', () => {
  it('opens a task that has not run in this session in the default mode, and keeps the mode of one that has', async () => {
    live().setPermissionMode('acceptEdits')
    await open('a')
    expect(live().permissionMode).toBe('default')
    live().setPermissionMode('plan')
    await open('b')
    expect(live().permissionMode).toBe('default')
    // Going back to a task brings back the mode it was left in during this session.
    await open('a')
    expect(live().permissionMode).toBe('plan')
    // It lives in memory only: nothing about it is saved with the task.
    expect(bridge.api.updateConversation.mock.calls.some(([, patch]) => patch && 'permissionMode' in patch)).toBe(false)
  })
})
