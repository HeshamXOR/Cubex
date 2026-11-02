import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@core/types'
import { connectionState, describeResult, keyState, parseDeployments, validateProvider } from './providerView'

const cfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  kind: 'openai',
  name: 'OpenAI',
  accessType: 'api',
  auth: { type: 'api_key' },
  enabled: true,
  ...overrides
})

describe('keyState: saved or missing, never the key', () => {
  it('is saved when a credential is stored', () => {
    expect(keyState(cfg({ credentialRef: 'cred_p' }))).toBe('saved')
  })

  it('is only optional for a custom endpoint, where a key may not exist at all', () => {
    expect(keyState(cfg({ kind: 'openai-compat', baseUrl: 'https://llm.example.com/v1' }))).toBe('missing')
    expect(keyState(cfg({ kind: 'openai-compat', accessType: 'local', baseUrl: 'http://192.168.1.4:8000/v1' }))).toBe('optional')
  })

})

describe('connectionState', () => {
  it('prefers a test in progress, then off, then a result, then what the setup suggests', () => {
    expect(connectionState(cfg({ enabled: false }), { testing: true })).toBe('testing')
    expect(connectionState(cfg({ enabled: false }), { result: { ok: true } })).toBe('disabled')
    expect(connectionState(cfg({ credentialRef: 'c' }), { result: { ok: true } })).toBe('ok')
    expect(connectionState(cfg({ credentialRef: 'c' }), { result: { ok: false, message: 'x' } })).toBe('failed')
    expect(connectionState(cfg(), {})).toBe('needs-key')
    expect(connectionState(cfg({ credentialRef: 'c' }), {})).toBe('untested')
  })

})

describe('describeResult', () => {
  it('reads a success into latency, models and what was checked', () => {
    const facts = describeResult(
      { ok: true, details: { endpoint: 'https://api.openai.com/v1', latencyMs: 142.4, models: 87, modelNoun: 'models', checked: 'Listed the models this key can use.' } },
      cfg()
    )
    expect(facts).toEqual({
      ok: true,
      title: 'Connected',
      latency: '142 ms',
      models: '87 models available',
      checked: 'Listed the models this key can use.',
      endpoint: 'https://api.openai.com/v1'
    })
  })

  it('reads a failure into what happened and what to do', () => {
    expect(describeResult({ ok: false, message: 'Authentication failed: check the API key.', details: { fix: 'Paste a valid key.' } }, cfg())).toEqual({
      ok: false,
      title: 'Could not connect',
      message: 'Authentication failed: check the API key.',
      fix: 'Paste a valid key.'
    })
  })

})

describe('validateProvider', () => {
  it('needs a name', () => {
    expect(validateProvider(cfg({ name: '  ', baseUrl: 'https://x.test' }))).toBe('Enter a display name.')
  })

  it('needs an http or https address, except for the offline demo', () => {
    expect(validateProvider(cfg({ baseUrl: '' }))).toMatch(/valid address/)
    expect(validateProvider(cfg({ baseUrl: 'ftp://x.test' }))).toMatch(/http/)
    expect(validateProvider(cfg({ baseUrl: 'https://api.openai.com/v1' }))).toBeUndefined()
    expect(validateProvider(cfg({ kind: 'mock', auth: { type: 'none' } }))).toBeUndefined()
  })

  it('needs the custom JSON fields', () => {
    const base = cfg({ kind: 'custom', baseUrl: 'https://x.test', mapping: { shape: 'rest', method: 'POST' } })
    expect(validateProvider(base)).toMatch(/prompt field/)
    expect(validateProvider({ ...base, mapping: { shape: 'rest', method: 'POST', promptField: 'prompt' } })).toMatch(/default model/)
    expect(validateProvider({ ...base, defaultModel: 'm', mapping: { shape: 'rest', method: 'POST', promptField: 'prompt' } })).toBeUndefined()
    expect(validateProvider({ ...base, mapping: { shape: 'openai' } })).toBeUndefined()
  })

  describe('Azure OpenAI', () => {
    const azure = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
      cfg({ kind: 'openai-compat', apiMode: 'azure', name: 'Azure OpenAI', azureResource: 'myres', azureDeployments: ['gpt-prod'], ...overrides })

    it('needs no address, only a resource and a deployment', () => {
      expect(validateProvider(azure())).toBeUndefined()
    })

    it('needs the resource name, and only the name', () => {
      expect(validateProvider(azure({ azureResource: '' }))).toMatch(/resource name/)
      expect(validateProvider(azure({ azureResource: 'https://myres.openai.azure.com' }))).toMatch(/not the full address/)
      expect(validateProvider(azure({ azureResource: 'my_res' }))).toMatch(/letters, digits and hyphens/)
    })

    it('needs a deployment, or a default one', () => {
      expect(validateProvider(azure({ azureDeployments: [] }))).toMatch(/deployment/)
      expect(validateProvider(azure({ azureDeployments: [], defaultModel: 'gpt-prod' }))).toBeUndefined()
    })
  })
})

describe('parseDeployments', () => {
  it('splits on commas, spaces and new lines and drops repeats and blanks', () => {
    expect(parseDeployments('gpt-prod, o3-mini-eu\n gpt-prod ,, ')).toEqual(['gpt-prod', 'o3-mini-eu'])
    expect(parseDeployments('')).toEqual([])
  })
})
