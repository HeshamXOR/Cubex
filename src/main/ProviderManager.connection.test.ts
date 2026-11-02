import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import type { AIProvider, ModelInfo, ProviderConfig, ProviderKind, ValidationResult } from '@core/types'

const state = vi.hoisted(() => ({
  localOnly: false,
  configs: new Map<string, ProviderConfig>()
}))
vi.mock('@core/providers', () => ({ createProvider: vi.fn() }))
vi.mock('./db', () => ({ providerRepo: { get: (id: string) => state.configs.get(id) } }))
vi.mock('./config', () => ({ getSettings: () => ({ privacy: { localOnly: state.localOnly } }) }))
vi.mock('./credentials', () => ({ getSecret: vi.fn() }))
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

import { ProviderManager } from './ProviderManager'

const model = (id: string): ModelInfo => ({
  id,
  providerId: 'p',
  displayName: id,
  location: 'cloud',
  capabilities: [],
  modalities: { input: ['text'], output: ['text'] },
  supportsTools: true,
  supportsStructuredOutput: false,
  supportsReasoning: false
})

function configure(overrides: Partial<ProviderConfig> & { kind?: ProviderKind } = {}): ProviderConfig {
  const cfg: ProviderConfig = { id: 'p', kind: 'openai', name: 'OpenAI', accessType: 'api', auth: { type: 'api_key' }, enabled: true, ...overrides }
  state.configs.set(cfg.id, cfg)
  return cfg
}

function provide(validate: ValidationResult | (() => Promise<ValidationResult>), models: ModelInfo[] | Error = []): { validate: ReturnType<typeof vi.fn>; getModels: ReturnType<typeof vi.fn> } {
  const validateFn = vi.fn(typeof validate === 'function' ? validate : async () => validate)
  const getModels = vi.fn(async () => {
    if (models instanceof Error) throw models
    return models
  })
  vi.mocked(createProvider).mockImplementation(() => ({ id: 'p', validateConfiguration: validateFn, getModels }) as unknown as AIProvider)
  return { validate: validateFn, getModels }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.localOnly = false
  state.configs.clear()
})

describe('ProviderManager.test', () => {
  it('reports how long the provider took, what was checked and how many models it offers', async () => {
    configure({ defaultModel: 'gpt-6-astra' })
    provide({ ok: true, details: { endpoint: 'https://api.openai.com/v1', models: 3 } }, [model('gpt-6-astra'), model('gpt-6-luna')])
    const manager = new ProviderManager()
    const result = await manager.test('p')
    expect(result).toMatchObject({
      ok: true,
      details: {
        endpoint: 'https://api.openai.com/v1',
        checked: 'Listed the models this key can use.',
        models: 2,
        modelNoun: 'models',
        defaultModelListed: true
      }
    })
    expect(result.details?.latencyMs).toEqual(expect.any(Number))
  })

  it('carries the fix with a failed check, and does not list models it cannot reach', async () => {
    configure({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' })
    const { getModels } = provide({ ok: false, message: 'Authentication failed: check the API key.' })
    const result = await new ProviderManager().test('p')
    expect(result).toMatchObject({ ok: false, message: 'Authentication failed: check the API key.' })
    expect(result.details?.fix).toBe('Paste a valid key from platform.openai.com/api-keys in Edit, save, then test again.')
    expect(result.details?.latencyMs).toEqual(expect.any(Number))
    expect(getModels).not.toHaveBeenCalled()
  })

  it('reports an adapter that throws instead of answering', async () => {
    configure()
    provide(async () => {
      throw new Error('socket hang up')
    })
    expect(await new ProviderManager().test('p')).toEqual({ ok: false, message: 'socket hang up' })
  })
})

describe('ProviderManager.refreshModels', () => {
  it('fetches the list again and reports the count', async () => {
    configure()
    provide({ ok: true }, [model('a'), model('b'), model('c'), model('d')])
    const manager = new ProviderManager()
    expect(await manager.refreshModels('p')).toEqual({ ok: true, count: 4 })
    expect(manager.registry.byProvider('p')).toHaveLength(4)
  })

  it('does not mistake an adapter\'s built-in list for a refresh when the provider cannot be reached', async () => {
    configure()
    const { getModels } = provide({ ok: false, message: 'Not reachable at https://x: fetch failed' }, [model('built-in')])
    const manager = new ProviderManager()
    manager.registry.replaceProvider('p', [model('a'), model('b')])
    const result = await manager.refreshModels('p')
    expect(result).toMatchObject({ ok: false, count: 2, message: 'Not reachable at https://x: fetch failed' })
    expect(result.fix).toMatch(/internet connection/)
    expect(getModels).not.toHaveBeenCalled()
    expect(manager.registry.byProvider('p').map((m) => m.id)).toEqual(['a', 'b'])
  })
})
