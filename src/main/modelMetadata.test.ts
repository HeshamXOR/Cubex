import { describe, expect, it } from 'vitest'
import type { Capability, ModelInfo, ProviderConfig } from '@core/types'
import type { CatalogModel } from './modelCatalog'
import { catalogEffortModel, catalogModelInfo, catalogProviderId, enrichModel, enrichModels, type CatalogReader } from './modelMetadata'

const cfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p', kind: 'openai-compat', name: 'P', accessType: 'api', auth: { type: 'api_key' }, enabled: true, ...overrides
})

const listed = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id, providerId: 'p', displayName: id, location: 'cloud', capabilities: ['text'] as Capability[],
  modalities: { input: ['text'], output: ['text'] }, supportsTools: true, supportsStructuredOutput: false, supportsReasoning: false, ...overrides
})

const K3: CatalogModel = {
  id: 'moonshotai/kimi-k3', providerId: 'nvidia', displayName: 'Kimi K3', family: 'kimi-k3', contextWindow: 1_048_576, maxOutputTokens: 131_072,
  supportsTools: true, supportsReasoning: true, supportsAttachments: true, reasoningEfforts: ['low', 'high', 'max'],
  pricing: { inputPerMTok: 0, outputPerMTok: 0, currency: 'USD', source: 'catalog' }, capabilities: ['text', 'tools']
}

/** A catalog with a few entries and one address the catalog itself lists. */
function catalog(entries: CatalogModel[] = [K3], hosts: Record<string, string> = { 'api.example-gateway.test': 'gateway' }): CatalogReader {
  return {
    lookup: (providerId, modelId) => entries.find((entry) => entry.providerId === providerId && entry.id === modelId),
    providerForHost: (host) => hosts[host]
  }
}

describe('which catalog provider a config talks to', () => {
  const reader = catalog()

  it.each([
    ['https://integrate.api.nvidia.com/v1', 'nvidia'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.together.ai/v1', 'togetherai'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://API.EXAMPLE-GATEWAY.TEST/v1', 'gateway']
  ])('matches %s by its host', (baseUrl, expected) => {
    expect(catalogProviderId(cfg({ baseUrl }), reader)).toBe(expected)
  })

  it('uses the vendor for a native adapter that sets no address', () => {
    expect(catalogProviderId(cfg({ kind: 'openai' }), reader)).toBe('openai')
    expect(catalogProviderId(cfg({ kind: 'anthropic' }), reader)).toBe('anthropic')
    expect(catalogProviderId(cfg({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }), reader)).toBe('google')
  })

  it('does not match a native adapter pointed at a gateway the catalog does not know', () => {
    expect(catalogProviderId(cfg({ kind: 'openai', baseUrl: 'https://llm.corp.test/v1' }), reader)).toBeUndefined()
  })

  it('never matches local runtimes, loopback addresses, Azure or the custom kinds', () => {
    for (const kind of ['ollama', 'lmstudio', 'llamacpp', 'custom', 'mock', 'mock-local'] as const) {
      expect(catalogProviderId(cfg({ kind, baseUrl: 'https://integrate.api.nvidia.com/v1' }), reader), kind).toBeUndefined()
    }
    expect(catalogProviderId(cfg({ baseUrl: 'http://127.0.0.1:8080/v1' }), reader)).toBeUndefined()
    expect(catalogProviderId(cfg({ baseUrl: 'http://192.168.1.20:8000/v1' }), reader)).toBeUndefined()
    expect(catalogProviderId(cfg({ apiMode: 'azure', baseUrl: 'https://res.openai.azure.com/openai/v1' }), reader)).toBeUndefined()
  })
})

describe('merging the catalog into a model list', () => {
  it('fills in the window, the limit, the price and the effort levels a compatible endpoint leaves out', () => {
    const [model] = enrichModels(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), [listed('moonshotai/kimi-k3')], catalog())
    expect(model).toMatchObject({
      contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsReasoning: true, family: 'kimi-k3',
      reasoningEfforts: ['low', 'high', 'max'], pricing: { inputPerMTok: 0, outputPerMTok: 0, source: 'catalog' }
    })
    expect(model!.capabilities).toContain('reasoning')
  })

  it('never overrides what the provider reported', () => {
    const reported = listed('moonshotai/kimi-k3', {
      contextWindow: 262_144, maxOutputTokens: 8_192, reasoningEfforts: ['low'], family: 'own', supportsReasoning: true,
      pricing: { currency: 'EUR', inputPerMTok: 1, outputPerMTok: 2 }
    })
    expect(enrichModel(reported, K3)).toEqual({ ...reported, capabilities: ['text', 'reasoning'] })
  })

  it('never turns a capability off', () => {
    const declared = listed('moonshotai/kimi-k3', { supportsReasoning: true })
    expect(enrichModel(declared, { ...K3, supportsReasoning: false, reasoningEfforts: undefined }).supportsReasoning).toBe(true)
  })

  it('leaves a model the catalog does not list, and a provider it cannot name, exactly as it was', () => {
    const models = [listed('vendor/unknown')]
    expect(enrichModels(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), models, catalog())[0]).toBe(models[0])
    expect(enrichModels(cfg({ baseUrl: 'http://127.0.0.1:1234/v1' }), models, catalog())).toBe(models)
    expect(enrichModels(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), models, undefined)).toBe(models)
  })

  it("does not take another provider's entry for a model with the same id", () => {
    const other = { ...K3, providerId: 'openrouter', contextWindow: 1 }
    const [model] = enrichModels(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), [listed('moonshotai/kimi-k3')], catalog([other]))
    expect(model!.contextWindow).toBeUndefined()
  })
})

describe('what a request learns about a model that was never listed', () => {
  it('is the window, the output limit, the price and the effort levels, as a cloud model', () => {
    expect(catalogModelInfo(cfg({ id: 'nv', baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'moonshotai/kimi-k3', catalog())).toMatchObject({
      id: 'moonshotai/kimi-k3', providerId: 'nv', displayName: 'Kimi K3', location: 'cloud', contextWindow: 1_048_576, maxOutputTokens: 131_072,
      supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'], pricing: { inputPerMTok: 0, outputPerMTok: 0, source: 'catalog' }
    })
  })

  it('is nothing for a model, a provider or a local address the catalog cannot name', () => {
    expect(catalogModelInfo(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'vendor/unknown', catalog())).toBeUndefined()
    expect(catalogModelInfo(cfg({ baseUrl: 'http://localhost:1/v1' }), 'moonshotai/kimi-k3', catalog())).toBeUndefined()
    expect(catalogModelInfo(cfg({ kind: 'ollama', baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'moonshotai/kimi-k3', catalog())).toBeUndefined()
    expect(catalogModelInfo(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'moonshotai/kimi-k3', undefined)).toBeUndefined()
  })
})

describe('what an adapter learns about a model it was never asked to list', () => {
  it('is the effort levels and whether it reasons', () => {
    expect(catalogEffortModel(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'moonshotai/kimi-k3', catalog())).toEqual({
      id: 'moonshotai/kimi-k3', supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max']
    })
  })

  it('is nothing when the model, the provider or the catalog is unknown', () => {
    expect(catalogEffortModel(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'vendor/unknown', catalog())).toBeUndefined()
    expect(catalogEffortModel(cfg({ baseUrl: 'http://localhost:1/v1' }), 'moonshotai/kimi-k3', catalog())).toBeUndefined()
    expect(catalogEffortModel(cfg({ baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'moonshotai/kimi-k3', undefined)).toBeUndefined()
  })
})
