import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import type { AIProvider, ModelInfo, ProviderConfig } from '@core/types'

const state = vi.hoisted(() => ({ localOnly: false, configs: new Map<string, ProviderConfig>() }))
vi.mock('@core/providers', () => ({ createProvider: vi.fn() }))
vi.mock('./db', () => ({ providerRepo: { get: (id: string) => state.configs.get(id) } }))
vi.mock('./config', () => ({ getSettings: () => ({ privacy: { localOnly: state.localOnly } }) }))
vi.mock('./credentials', () => ({ getSecret: () => undefined }))
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

import { ProviderManager } from './ProviderManager'
import type { CatalogModel } from './modelCatalog'

const K3: CatalogModel = {
  id: 'moonshotai/kimi-k3', providerId: 'nvidia', displayName: 'Kimi K3', contextWindow: 1_048_576, maxOutputTokens: 131_072,
  supportsTools: true, supportsReasoning: true, supportsAttachments: true, reasoningEfforts: ['low', 'high', 'max'],
  pricing: { inputPerMTok: 0, outputPerMTok: 0, currency: 'USD', source: 'catalog' }, capabilities: ['text']
}

const NVIDIA: ProviderConfig = {
  id: 'nv', kind: 'openai-compat', name: 'NVIDIA', accessType: 'api', baseUrl: 'https://integrate.api.nvidia.com/v1', auth: { type: 'api_key' }, enabled: true
}

const listed = (id: string): ModelInfo => ({
  id, providerId: 'nv', displayName: id, location: 'cloud', capabilities: ['text'], modalities: { input: ['text'], output: ['text'] },
  supportsTools: true, supportsStructuredOutput: false, supportsReasoning: false
})

function catalog() {
  return {
    ready: vi.fn(async () => undefined),
    lookup: (providerId: string, modelId: string) => (providerId === 'nvidia' && modelId === K3.id ? K3 : undefined),
    providerForHost: () => undefined
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.localOnly = false
  state.configs.clear()
  state.configs.set(NVIDIA.id, NVIDIA)
  vi.mocked(createProvider).mockImplementation(() => ({ id: 'nv', getModels: async () => [listed(K3.id), listed('vendor/other')] }) as unknown as AIProvider)
})

describe('ProviderManager and the model catalog', () => {
  it('lists models with the catalog merged in, and keeps them for the chat that follows', async () => {
    const manager = new ProviderManager({ catalog: catalog() })
    const models = await manager.listModels('nv')
    expect(models[0]).toMatchObject({ contextWindow: 1_048_576, reasoningEfforts: ['low', 'high', 'max'], supportsReasoning: true })
    expect(models[1]).toEqual(listed('vendor/other'))
    // The registry is what the chat reads for the context window and the price.
    expect(manager.getModelInfo('nv', K3.id)).toMatchObject({ contextWindow: 1_048_576, pricing: { inputPerMTok: 0, outputPerMTok: 0 } })
  })

  it('waits for a first download, but not in local-only mode', async () => {
    const online = catalog()
    await new ProviderManager({ catalog: online }).listModels('nv')
    expect(online.ready).toHaveBeenCalledTimes(1)

    state.localOnly = true
    // A compatible endpoint declared local is allowed in this mode, wherever its address points.
    state.configs.set(NVIDIA.id, { ...NVIDIA, accessType: 'local' })
    const offline = catalog()
    const models = await new ProviderManager({ catalog: offline }).listModels('nv')
    expect(offline.ready).not.toHaveBeenCalled()
    // What is already on disk is still used.
    expect(models[0]!.reasoningEfforts).toEqual(['low', 'high', 'max'])
  })

  it('still lists models when the catalog fails', async () => {
    const broken = { ...catalog(), ready: vi.fn(async () => { throw new Error('offline') }) }
    const models = await new ProviderManager({ catalog: broken }).listModels('nv')
    expect(models).toHaveLength(2)
  })

  it('lists models as reported when there is no catalog', async () => {
    expect(await new ProviderManager().listModels('nv')).toEqual([listed(K3.id), listed('vendor/other')])
  })

  it('tells the adapter what the catalog knows about a model before it was ever listed', () => {
    new ProviderManager({ catalog: catalog() }).resolve('nv')
    const options = vi.mocked(createProvider).mock.calls[0]![2]!
    expect(options.modelInfo!(K3.id)).toEqual({ id: K3.id, supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'] })
    expect(options.modelInfo!('vendor/other')).toBeUndefined()
  })

  it('prefers the listed entry once the provider has been asked', async () => {
    const manager = new ProviderManager({ catalog: catalog() })
    manager.resolve('nv')
    await manager.listModels('nv')
    const options = vi.mocked(createProvider).mock.calls[0]![2]!
    expect(options.modelInfo!(K3.id)).toMatchObject({ id: K3.id, reasoningEfforts: ['low', 'high', 'max'] })
  })

  it('gives a request the catalog window and price for a model that was never listed', () => {
    const manager = new ProviderManager({ catalog: catalog() })
    expect(manager.getModelInfo('nv', K3.id)).toMatchObject({ location: 'cloud', contextWindow: 1_048_576, pricing: { inputPerMTok: 0, outputPerMTok: 0 } })
    expect(manager.getModelInfo('nv', 'vendor/other')).toBeUndefined()
    expect(manager.getModelInfo('missing', K3.id)).toBeUndefined()
    expect(new ProviderManager().getModelInfo('nv', K3.id)).toBeUndefined()
  })

  it('keeps the window and price when the model list could not be fetched', async () => {
    vi.mocked(createProvider).mockImplementation(() => ({ id: 'nv', getModels: async () => { throw new Error('timeout') } }) as unknown as AIProvider)
    const manager = new ProviderManager({ catalog: catalog() })
    expect(await manager.listModels('nv')).toEqual([])
    expect(manager.getModelInfo('nv', K3.id)).toMatchObject({ contextWindow: 1_048_576 })
  })

  it('does not describe a local runtime from the catalog, whatever its model is called', () => {
    state.configs.set(NVIDIA.id, { ...NVIDIA, kind: 'ollama', baseUrl: 'http://localhost:11434' })
    expect(new ProviderManager({ catalog: catalog() }).getModelInfo('nv', K3.id)).toBeUndefined()
  })
})
