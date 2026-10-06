import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@core/types'
import {
  accessMode,
  connectionState,
  countLabel,
  describeRefresh,
  describeResult,
  keyState,
  kindLabel,
  parseDeployments,
  rowFacts,
  sameLabel,
  validateProvider
} from './providerView'

const cfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  kind: 'openai',
  name: 'OpenAI',
  accessType: 'api',
  auth: { type: 'api_key' },
  enabled: true,
  ...overrides
})

describe('sameLabel', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(sameLabel('OpenAI', 'openai')).toBe(true)
    expect(sameLabel('LM Studio', 'LM-Studio')).toBe(true)
    expect(sameLabel('llama.cpp', 'Llamacpp')).toBe(true)
    expect(sameLabel('NVIDIA', 'OpenAI-compatible')).toBe(false)
  })
})

describe('rowFacts: a row never says the same thing twice', () => {
  it('leaves the kind out when the name already says it', () => {
    expect(rowFacts(cfg({ kind: 'anthropic', name: 'Anthropic' })).kind).toBeUndefined()
    expect(rowFacts(cfg({ kind: 'ollama', name: 'Ollama', accessType: 'local' })).kind).toBeUndefined()
    expect(rowFacts(cfg({ kind: 'lmstudio', name: 'LM Studio', accessType: 'local' })).kind).toBeUndefined()
    expect(rowFacts(cfg({ kind: 'openai-compat', apiMode: 'azure', name: 'Azure OpenAI' })).kind).toBeUndefined()
  })

  it('names the kind when it adds something', () => {
    expect(rowFacts(cfg({ kind: 'openai-compat', name: 'NVIDIA' })).kind).toBe('OpenAI-compatible')
    expect(rowFacts(cfg({ kind: 'anthropic', name: 'Team proxy' })).kind).toBe('Anthropic')
    expect(rowFacts(cfg({ kind: 'custom', name: 'Search' })).kind).toBe('Custom JSON API')
  })

  it('shows where it lives as a host, and the model', () => {
    expect(rowFacts(cfg({ baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-astra' }))).toMatchObject({ endpoint: 'api.openai.com', model: 'gpt-6-astra' })
  })

  it('shows nothing it does not know', () => {
    expect(rowFacts(cfg({ kind: 'openai-compat', name: 'Mine' }))).toEqual({ kind: 'OpenAI-compatible' })
  })

  it('does not repeat the name as the endpoint', () => {
    expect(rowFacts(cfg({ name: 'api.openai.com', baseUrl: 'https://api.openai.com/v1' })).endpoint).toBeUndefined()
  })
})

describe('kindLabel and accessMode', () => {
  it('names each kind', () => {
    expect(kindLabel(cfg({ kind: 'gemini' }))).toBe('Google Gemini')
    expect(kindLabel(cfg({ kind: 'llamacpp' }))).toBe('llama.cpp')
    expect(kindLabel(cfg({ kind: 'mock' }))).toBe('Offline demo')
    expect(kindLabel(cfg({ kind: 'openai-compat', apiMode: 'azure' }))).toBe('Azure OpenAI')
  })

  it('treats local runtimes, local-declared endpoints and the demo as such, and Azure as always cloud', () => {
    expect(accessMode(cfg({ kind: 'ollama' }))).toBe('local')
    expect(accessMode(cfg({ kind: 'openai-compat', accessType: 'local' }))).toBe('local')
    expect(accessMode(cfg({ kind: 'openai-compat', accessType: 'local', apiMode: 'azure' }))).toBe('cloud')
    expect(accessMode(cfg({ kind: 'openai', accessType: 'local' }))).toBe('cloud')
    expect(accessMode(cfg({ kind: 'mock' }))).toBe('offline')
  })
})

describe('keyState: saved or missing, never the key', () => {
  it('is saved when a credential is stored', () => {
    expect(keyState(cfg({ credentialRef: 'cred_p' }))).toBe('saved')
  })

  it('is missing for a cloud provider with none', () => {
    expect(keyState(cfg())).toBe('missing')
    expect(keyState(cfg({ kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' }))).toBe('missing')
  })

  it('is only optional for a custom endpoint, where a key may not exist at all', () => {
    expect(keyState(cfg({ kind: 'openai-compat', baseUrl: 'https://llm.example.com/v1' }))).toBe('missing')
    expect(keyState(cfg({ kind: 'openai-compat', accessType: 'local', baseUrl: 'http://192.168.1.4:8000/v1' }))).toBe('optional')
  })

  it('is none where no key is used', () => {
    expect(keyState(cfg({ kind: 'ollama', auth: { type: 'none' } }))).toBe('none')
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

  it('lets a result beat a missing key, since the test is what the person just saw', () => {
    expect(connectionState(cfg(), { result: { ok: false, message: 'x' } })).toBe('failed')
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

  it('writes slow responses in seconds and singular counts correctly', () => {
    expect(describeResult({ ok: true, details: { latencyMs: 2450, models: 1 } }, cfg())).toMatchObject({ latency: '2.5 s', models: '1 model available' })
    expect(describeResult({ ok: true, details: { models: 3, modelNoun: 'deployments' } }, cfg())).toMatchObject({ models: '3 deployments available' })
  })

  it('flags a default model the provider does not offer', () => {
    expect(describeResult({ ok: true, details: { defaultModelListed: false } }, cfg()).defaultModelMissing).toBe(true)
    expect(describeResult({ ok: true, details: { defaultModelListed: true } }, cfg()).defaultModelMissing).toBeUndefined()
  })

  it('reads a failure into what happened and what to do', () => {
    expect(describeResult({ ok: false, message: 'Authentication failed: check the API key.', details: { fix: 'Paste a valid key.' } }, cfg())).toEqual({
      ok: false,
      title: 'Could not connect',
      message: 'Authentication failed: check the API key.',
      fix: 'Paste a valid key.'
    })
  })

  it('still says something when the adapter said nothing', () => {
    expect(describeResult({ ok: false }, cfg()).message).toBe('The provider did not answer.')
  })

  it('says a custom JSON endpoint was only reached', () => {
    expect(describeResult({ ok: true, details: { status: 405 } }, cfg({ kind: 'custom' })).checked).toBe('Reached the endpoint. The request and response mapping were not tested.')
  })

  it('ignores details that are not the type it expects', () => {
    expect(describeResult({ ok: true, details: { latencyMs: 'fast', models: -1, fix: 5 } }, cfg())).toEqual({ ok: true, title: 'Connected' })
  })
})

describe('describeRefresh', () => {
  it('reports the count', () => {
    expect(describeRefresh({ ok: true, count: 12 })).toEqual({ title: 'Model list refreshed', body: '12 models available.' })
  })

  it('says what stayed when a refresh fails, and what to do', () => {
    expect(describeRefresh({ ok: false, count: 12, message: 'Not reachable.', fix: 'Check the address.' })).toEqual({
      title: 'Could not refresh the model list',
      body: 'Not reachable. Cubex keeps the 12 models it already knew.',
      fix: 'Check the address.'
    })
    expect(describeRefresh({ ok: false, count: 0, message: 'Turned off.' }).body).toBe('Turned off.')
  })
})

describe('countLabel', () => {
  it('groups thousands and agrees with the count', () => {
    expect(countLabel(1)).toBe('1 model')
    expect(countLabel(0)).toBe('0 models')
    expect(countLabel(1204)).toBe('1,204 models')
    expect(countLabel(2, 'deployment')).toBe('2 deployments')
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
