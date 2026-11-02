import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import type { ProviderConfig } from '@core/types'

const state = vi.hoisted(() => ({
  localOnly: false,
  configs: new Map<string, ProviderConfig>(),
  secret: vi.fn()
}))
vi.mock('@core/providers', () => ({ createProvider: vi.fn() }))
vi.mock('./db', () => ({ providerRepo: { get: (id: string) => state.configs.get(id) } }))
vi.mock('./config', () => ({ getSettings: () => ({ privacy: { localOnly: state.localOnly } }) }))
vi.mock('./credentials', () => ({ getSecret: state.secret }))
vi.mock('./logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

import { ProviderManager } from './ProviderManager'

function configure(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const cfg: ProviderConfig = {
    id: 'gem',
    kind: 'gemini',
    name: 'Gemini',
    accessType: 'api',
    auth: { type: 'api_key' },
    enabled: true,
    ...overrides
  }
  state.configs.set(cfg.id, cfg)
  return cfg
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  state.localOnly = false
  state.configs.clear()
  state.secret.mockReturnValue(undefined)
  vi.mocked(createProvider).mockImplementation(() => ({ id: 'gem' }) as never)
})

describe('ProviderManager and the gemini kind', () => {
  it('is a cloud adapter: Local Only blocks it, even when the config claims local access', () => {
    state.localOnly = true
    for (const accessType of ['api', 'local'] as const) {
      configure({ accessType })
      expect(() => new ProviderManager().resolve('gem')).toThrow(expect.objectContaining({ rawCode: 'LOCAL_ONLY_MODE', retryable: false }))
    }
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('prefers the stored credential over the environment', () => {
    const cfg = configure({ credentialRef: 'cred_gem' })
    state.secret.mockReturnValue('stored-key')
    vi.stubEnv('CUBEX_GEMINI_API_KEY', 'env-key')
    new ProviderManager().resolve('gem')
    expect(createProvider).toHaveBeenCalledWith(cfg, 'stored-key', expect.anything())
  })
})

describe('ProviderManager and the Azure OpenAI mode', () => {
  it('is a cloud endpoint: Local Only blocks it even when the config declares local access', () => {
    state.localOnly = true
    configure({ id: 'az', kind: 'openai-compat', apiMode: 'azure', accessType: 'local', azureResource: 'myres' })
    expect(() => new ProviderManager().resolve('az')).toThrow(expect.objectContaining({ rawCode: 'LOCAL_ONLY_MODE' }))
    expect(createProvider).not.toHaveBeenCalled()
  })
})
