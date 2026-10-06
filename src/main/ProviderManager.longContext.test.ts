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

const SONNET: CatalogModel = {
  id: 'claude-sonnet-4-5-20250929', providerId: 'anthropic', displayName: 'Claude Sonnet 4.5', family: 'claude-sonnet-4',
  contextWindow: 200_000, maxOutputTokens: 64_000, supportsTools: true, supportsReasoning: true, supportsAttachments: true,
  reasoningEfforts: ['low', 'high'], capabilities: ['text']
}

/** A provider whose own list settles only the two ordinary models, the way a relay lists a gated one. */
const CONFIG: ProviderConfig = {
  id: 'relay', kind: 'anthropic', name: 'Relay', accessType: 'api', baseUrl: 'https://api.anthropic.com',
  auth: { type: 'api_key' }, enabled: true, longContextModels: ['claude-sonnet-4-5-20250929', 'claude-not-listed']
}

const listed = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id, providerId: 'relay', displayName: id, location: 'cloud', capabilities: ['text'], modalities: { input: ['text'], output: ['text'] },
  supportsTools: true, supportsStructuredOutput: true, supportsReasoning: false, contextWindow: 200_000, ...overrides
})

/** The catalog reads one entry for the declared model, and knows nothing about the other. */
function catalog() {
  return {
    ready: vi.fn(async () => undefined),
    lookup: (providerId: string, modelId: string) => (providerId === 'anthropic' && modelId === SONNET.id ? SONNET : undefined),
    providerForHost: () => undefined
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.localOnly = false
  state.configs.clear()
  state.configs.set(CONFIG.id, CONFIG)
  vi.mocked(createProvider).mockImplementation(() => ({
    id: 'relay',
    name: 'Relay',
    getModels: async () => [listed('claude-sonnet-4-5-20250929'), listed('claude-haiku-4-5', { contextWindow: 200_000 })]
  }) as unknown as AIProvider)
})

describe('1M context models declared on a provider', () => {
  it('marks the declared model, leaves the rest, and adds the one the provider never listed', async () => {
    const models = await new ProviderManager({ catalog: catalog() }).listModels('relay')
    expect(models.find((m) => m.id === 'claude-sonnet-4-5-20250929')?.longContextBeta).toBe(true)
    expect(models.find((m) => m.id === 'claude-haiku-4-5')?.longContextBeta).toBeUndefined()
    // The declared model the endpoint does not serve is offered too, with the catalog's description.
    const unlisted = models.find((m) => m.id === 'claude-not-listed')
    expect(unlisted).toMatchObject({ longContextBeta: true, displayName: 'claude-not-listed' })
    expect(unlisted?.contextWindow).toBeUndefined()
  })

  it('gives the request the same option for a model that was never listed', async () => {
    const manager = new ProviderManager({ catalog: catalog() })
    await manager.listModels('relay')
    expect(manager.getModelInfo('relay', 'claude-sonnet-4-5-20250929')?.longContextBeta).toBe(true)
    // Before any list is fetched: the declared model is still described, so the composer can offer the switch.
    const fresh = new ProviderManager({ catalog: catalog() })
    expect(fresh.getModelInfo('relay', 'claude-sonnet-4-5-20250929')).toMatchObject({ longContextBeta: true, contextWindow: 200_000 })
    expect(fresh.getModelInfo('relay', 'claude-haiku-4-5')?.longContextBeta).toBeUndefined()
    // A model nobody declared keeps the plain catalog answer.
    expect(fresh.getModelInfo('relay', 'claude-opus-4-8')).toBeUndefined()
  })
})
