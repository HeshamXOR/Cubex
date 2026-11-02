import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import { AIGateway, type GatewayCallOptions } from '@core/gateway/AIGateway'
import { MockAIProvider } from '@core/providers/mock/MockAIProvider'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIRequest, AIResponse, ProviderConfig, ProviderKind, RoutingPolicy } from '@core/types'

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

const request: AIRequest = { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
const blocked = { category: 'AUTHORIZATION_ERROR', classification: 'permanent', retryable: false, rawCode: 'LOCAL_ONLY_MODE' }

function configure(kind: ProviderKind, accessType: ProviderConfig['accessType'] = 'api', id = kind): ProviderConfig {
  const cfg: ProviderConfig = { id, kind, name: `Fixture ${id}`, accessType, auth: { type: 'none' }, enabled: true }
  state.configs.set(id, cfg)
  return cfg
}

function routing(primary: string, fallbacks: string[] = []): RoutingPolicy {
  return {
    primary: { providerId: primary, model: 'fixture' },
    fallbacks: fallbacks.map((providerId) => ({ providerId, model: 'fixture' })),
    fallbackEnabled: fallbacks.length > 0,
    retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
    timeout: {}
  }
}

async function run(gateway: AIGateway, mode: 'send' | 'stream', policy: RoutingPolicy, opts: GatewayCallOptions = {}): Promise<AIResponse> {
  const options = { retryHooks: { sleep: async () => {} }, ...opts }
  if (mode === 'send') return gateway.send(request, policy, options)
  for await (const event of gateway.stream(request, policy, options)) {
    if (event.type === 'error') throw event.error
    if (event.type === 'completed') return event.response
  }
  throw new Error('Stream ended without a response or error')
}

beforeEach(() => {
  vi.clearAllMocks()
  state.localOnly = false
  state.configs.clear()
  vi.mocked(createProvider).mockImplementation((cfg) => new MockAIProvider({ id: cfg.id, reply: 'Local fixture response' }))
})

describe('ProviderManager Local Only model routing', () => {
  it.each<ProviderKind>(['openai', 'anthropic', 'custom', 'openai-compat'])('rejects %s before constructing an adapter or reading credentials', (kind) => {
    const cfg = configure(kind)
    state.localOnly = true
    const manager = new ProviderManager()
    expect(() => manager.resolve(cfg.id)).toThrow('Local-only mode')
    expect(() => manager.resolve(cfg.id)).toThrow(expect.objectContaining(blocked))
    expect(createProvider).not.toHaveBeenCalled()
    expect(state.secret).not.toHaveBeenCalled()
  })

  it.each<ProviderKind>(['openai', 'anthropic'])('does not allow a native %s adapter to bypass policy by declaring local access', (kind) => {
    const cfg = configure(kind, 'local')
    state.localOnly = true
    expect(() => new ProviderManager().resolve(cfg.id)).toThrow(expect.objectContaining(blocked))
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('checks the current toggle before cache retrieval and reuses the adapter after Local Only is disabled', () => {
    const cfg = configure('openai')
    const manager = new ProviderManager()
    const provider = manager.resolve(cfg.id)
    state.localOnly = true
    expect(() => manager.resolve(cfg.id)).toThrow(expect.objectContaining(blocked))
    state.localOnly = false
    expect(manager.resolve(cfg.id)).toBe(provider)
    expect(createProvider).toHaveBeenCalledTimes(1)
  })

  it('blocks cloud model discovery and reports a clear failed connection test', async () => {
    const cfg = configure('anthropic')
    const manager = new ProviderManager()
    const provider = manager.resolve(cfg.id)!
    const modelList = vi.spyOn(provider, 'getModels')
    const validate = vi.spyOn(provider, 'validateConfiguration')
    state.localOnly = true
    await expect(manager.listModels(cfg.id)).rejects.toMatchObject(blocked)
    await expect(manager.test(cfg.id)).resolves.toEqual({ ok: false, message: expect.stringContaining('Local-only mode') })
    expect(modelList).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })
})

describe.each(['send', 'stream'] as const)('Local Only through AIGateway.%s', (mode) => {
  it('blocks a cached cloud primary without calling or retrying the adapter', async () => {
    configure('openai')
    const manager = new ProviderManager()
    const provider = manager.resolve('openai')!
    const call = vi.spyOn(provider, mode === 'send' ? 'sendMessage' : 'streamMessage')
    const sleep = vi.fn(async () => {})
    state.localOnly = true
    await expect(run(new AIGateway(manager.resolve), mode, routing('openai'), { retryHooks: { sleep } })).rejects.toMatchObject(blocked)
    expect(call).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('skips a blocked cloud primary and cloud fallback to reach an explicitly enabled local fallback', async () => {
    configure('openai')
    configure('anthropic')
    configure('ollama', 'local')
    state.localOnly = true
    const response = await run(new AIGateway(new ProviderManager().resolve), mode, routing('openai', ['anthropic', 'ollama']))
    expect(response.provider).toBe('ollama')
    expect(vi.mocked(createProvider).mock.calls.map(([cfg]) => cfg.id)).toEqual(['ollama'])
  })

  it('rechecks Local Only after a retry wait and does not send another cloud request', async () => {
    configure('openai')
    const manager = new ProviderManager()
    const provider = manager.resolve('openai')! as MockAIProvider
    provider.setScenario('fail_then_succeed')
    const call = vi.spyOn(provider, mode === 'send' ? 'sendMessage' : 'streamMessage')
    const sleep = vi.fn(async () => { state.localOnly = true })
    await expect(run(new AIGateway(manager.resolve), mode, routing('openai'), { retryHooks: { sleep } })).rejects.toMatchObject(blocked)
    expect(call).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
