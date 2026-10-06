import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import { fakeFetch, jsonResponse } from '@core/providers/gemini/testSupport'
import {
  configFromPreset,
  endpointLabel,
  hostOf,
  PRESET_GROUPS,
  presetById,
  presetFor,
  PROVIDER_PRESETS,
  type ProviderPreset
} from './providerPresets'

const sdk = vi.hoisted(() => ({ openai: [] as Array<Record<string, unknown>>, anthropic: [] as Array<Record<string, unknown>> }))
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  return {
    ...actual,
    default: class {
      models = { list: async () => ({ data: [{ id: 'gpt-6-astra' }] }) }
      constructor(options: Record<string, unknown>) {
        sdk.openai.push(options)
      }
    }
  }
})
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  return {
    ...actual,
    default: class {
      messages = { create: async () => ({}) }
      constructor(options: Record<string, unknown>) {
        sdk.anthropic.push(options)
      }
    }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  sdk.openai.length = 0
  sdk.anthropic.length = 0
})

const KEY = 'preset-test-key-0123456789'

describe('the preset list', () => {
  it('has the providers the chooser promises, once each', () => {
    expect(PROVIDER_PRESETS.map((p) => p.label)).toEqual([
      'OpenAI',
      'Anthropic',
      'Google Gemini',
      'Azure OpenAI',
      'OpenRouter',
      'Groq',
      'Together',
      'DeepSeek',
      'Mistral',
      'xAI',
      'NVIDIA',
      'Ollama',
      'LM Studio',
      'llama.cpp',
      'Custom endpoint',
      'Custom JSON API',
      'Offline demo'
    ])
    expect(new Set(PROVIDER_PRESETS.map((p) => p.id)).size).toBe(PROVIDER_PRESETS.length)
  })

  it('files every preset under a group the chooser shows', () => {
    const groups = new Set(PRESET_GROUPS.map((g) => g.id))
    for (const preset of PROVIDER_PRESETS) expect(groups.has(preset.group), preset.id).toBe(true)
  })

  it.each(PROVIDER_PRESETS.map((p) => [p.id, p] as const))('%s says in one plain sentence what it needs', (_id, preset) => {
    expect(preset.needs.endsWith('.')).toBe(true)
    expect(preset.needs.split(/\.\s/).length).toBeLessThanOrEqual(2)
    expect(preset.needs).not.toMatch(/ — | · |[\u{1F300}-\u{1FAFF}]/u)
    expect(preset.needs).not.toMatch(/AI-powered|seamless|powerful|best/i)
  })

  it('asks for a key exactly where one is needed', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.group === 'cloud') expect(preset.keyRequired, preset.id).toBe(true)
      if (preset.group === 'local') expect(preset.key, preset.id).toBeUndefined()
      if (preset.keyRequired) expect(preset.key, preset.id).toBeDefined()
      if (preset.group === 'cloud') expect(preset.keyPage, preset.id).toBeTruthy()
    }
  })

  it('gives every addressed preset an https address (cloud) or a loopback one (local)', () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.baseUrl)) {
      const url = new URL(preset.baseUrl!)
      if (preset.group === 'cloud') expect(url.protocol, preset.id).toBe('https:')
      if (preset.group === 'local') expect(url.hostname, preset.id).toBe('127.0.0.1')
      expect(preset.baseUrl!.endsWith('/'), preset.id).toBe(false)
    }
  })
})

describe('configFromPreset', () => {
  it('fills in everything but the key', () => {
    expect(configFromPreset(presetById('openai')!, 'abc')).toEqual({
      id: 'abc',
      kind: 'openai',
      name: 'OpenAI',
      accessType: 'api',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
      defaultModel: 'gpt-6-astra',
      auth: { type: 'api_key', scheme: 'bearer' },
      enabled: true
    })
  })

  it('sends Anthropic keys in x-api-key', () => {
    expect(configFromPreset(presetById('anthropic')!, 'a').auth).toEqual({ type: 'api_key', scheme: 'x-api-key' })
  })

  it('sets Azure up for its resource and its api-key header', () => {
    expect(configFromPreset(presetById('azure')!, 'az')).toEqual({
      id: 'az',
      kind: 'openai-compat',
      name: 'Azure OpenAI',
      accessType: 'api',
      apiMode: 'azure',
      apiVersion: 'v1',
      azureResource: '',
      azureDeployments: [],
      auth: { type: 'api_key', scheme: 'raw', headerName: 'api-key' },
      enabled: true
    })
  })

  it('needs no auth for a local server, and marks it local', () => {
    expect(configFromPreset(presetById('ollama')!, 'o')).toMatchObject({ kind: 'ollama', accessType: 'local', baseUrl: 'http://127.0.0.1:11434', auth: { type: 'none' } })
  })

  it('starts the JSON endpoint with a mapping the form can edit', () => {
    expect(configFromPreset(presetById('custom-json')!, 'c')).toMatchObject({
      kind: 'custom',
      mapping: { shape: 'rest', method: 'POST', promptField: 'prompt', modelField: 'model', responseTextPath: 'text' }
    })
  })

  it('leaves the address of a custom endpoint blank for the person to fill in', () => {
    expect(configFromPreset(presetById('custom')!, 'x')).toMatchObject({ kind: 'openai-compat', baseUrl: '' })
  })
})

describe('presetFor and endpointLabel', () => {
  it('finds a preset by what the provider connects to, whatever it is called', () => {
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' })?.id).toBe('groq')
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://API.Groq.com/openai/v1/' })?.id).toBe('groq')
    expect(presetFor({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' })?.id).toBe('ollama')
  })

  it('knows a native provider without an address', () => {
    expect(presetFor({ kind: 'anthropic' })?.id).toBe('anthropic')
    expect(presetFor({ kind: 'openai', baseUrl: '  ' })?.id).toBe('openai')
    expect(presetFor({ kind: 'gemini' })?.id).toBe('gemini')
  })

  it('does not guess for a compatible endpoint it has never heard of', () => {
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://llm.example.com/v1' })).toBeUndefined()
    expect(presetFor({ kind: 'openai-compat' })).toBeUndefined()
  })

  it('recognises Azure by its mode', () => {
    expect(presetFor({ kind: 'openai-compat', apiMode: 'azure' })?.id).toBe('azure')
  })

  it('reads the host out of an address', () => {
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com')
    expect(hostOf('http://127.0.0.1:11434')).toBe('127.0.0.1:11434')
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf(undefined)).toBeUndefined()
  })

  it('labels where a provider lives', () => {
    expect(endpointLabel({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe('api.openai.com')
    expect(endpointLabel({ kind: 'anthropic' })).toBe('api.anthropic.com')
    expect(endpointLabel({ kind: 'openai-compat', apiMode: 'azure', azureResource: 'myres' })).toBe('myres.openai.azure.com')
    expect(endpointLabel({ kind: 'openai-compat', apiMode: 'azure', azureResource: '' })).toBeUndefined()
    expect(endpointLabel({ kind: 'openai-compat' })).toBeUndefined()
  })
})

/** Run the provider's own connection check against a fake network and report what it asked for. */
async function check(preset: ProviderPreset, reply: unknown, edit: (cfg: ReturnType<typeof configFromPreset>) => void = () => undefined) {
  const { fetch, calls } = fakeFetch(jsonResponse(reply))
  vi.stubGlobal('fetch', fetch)
  const cfg = configFromPreset(preset, 'p')
  edit(cfg)
  const result = await createProvider(cfg, preset.key ? KEY : undefined).validateConfiguration()
  return { result, calls }
}

describe.each(PROVIDER_PRESETS.filter((p) => p.kind === 'openai-compat' && !p.azure && p.baseUrl).map((p) => [p.id, p] as const))(
  '%s as an OpenAI-compatible host',
  (_id, preset) => {
    it('lists its models at the preset address with the key as a bearer token', async () => {
      const { result, calls } = await check(preset, { data: [{ id: 'one' }, { id: 'two' }] })
      expect(result.ok).toBe(true)
      expect(result.details).toMatchObject({ models: 2 })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe(`${preset.baseUrl}/models`)
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    })

    it('speaks chat completions at the same address', async () => {
      const { fetch, calls } = fakeFetch(
        new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      )
      vi.stubGlobal('fetch', fetch)
      const provider = createProvider(configFromPreset(preset, 'p'), KEY)
      const events: string[] = []
      for await (const event of provider.streamMessage({ model: preset.defaultModel!, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) events.push(event.type)
      expect(calls[0]!.url).toBe(`${preset.baseUrl}/chat/completions`)
      expect(calls[0]!.body).toMatchObject({ model: preset.defaultModel })
      expect(events).toContain('text_delta')
    })
  }
)

describe('local servers', () => {
  it.each(['lmstudio', 'llamacpp'])('%s lists models over the OpenAI-compatible route without a key', async (id) => {
    const preset = presetById(id)!
    const { result, calls } = await check(preset, { data: [{ id: 'local-model' }] })
    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe(`${preset.baseUrl}/models`)
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('ollama asks the server for its version', async () => {
    const preset = presetById('ollama')!
    const { result, calls } = await check(preset, { version: '0.5.7' })
    expect(result).toMatchObject({ ok: true, details: { version: '0.5.7' } })
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/version')
  })
})

describe('Google Gemini', () => {
  it('lists chat models with the key in x-goog-api-key, never in the address', async () => {
    const { result, calls } = await check(presetById('gemini')!, { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] })
    expect(result).toMatchObject({ ok: true, details: { models: 1 } })
    expect(calls[0]!.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/)
    expect(calls[0]!.url).not.toContain(KEY)
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY)
  })
})

describe('Azure OpenAI', () => {
  const named = (cfg: ReturnType<typeof configFromPreset>): void => {
    cfg.azureResource = 'myres'
    cfg.azureDeployments = ['gpt-prod', 'o3-mini-eu']
    cfg.defaultModel = 'gpt-prod'
  }

  it('reaches the resource named in the form, with the key in api-key and no bearer token', async () => {
    const { result, calls } = await check(presetById('azure')!, { data: [] }, named)
    expect(result).toMatchObject({ ok: true, details: { deployments: 2 } })
    expect(calls[0]!.url).toBe('https://myres.openai.azure.com/openai/v1/models')
    expect(calls[0]!.headers['api-key']).toBe(KEY)
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('offers the deployment names as the models', async () => {
    vi.stubGlobal('fetch', fakeFetch(jsonResponse({})).fetch)
    const cfg = configFromPreset(presetById('azure')!, 'p')
    named(cfg)
    expect((await createProvider(cfg, KEY).getModels()).map((m) => m.id)).toEqual(['gpt-prod', 'o3-mini-eu'])
  })

  it('sends the deployment name as the model on the v1 route, and in the path on a dated one', async () => {
    const stream = (): Response => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const ask = { model: 'gpt-prod', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] }

    const v1 = fakeFetch(stream())
    vi.stubGlobal('fetch', v1.fetch)
    const cfg = configFromPreset(presetById('azure')!, 'p')
    named(cfg)
    for await (const _event of createProvider(cfg, KEY).streamMessage(ask)) void _event
    expect(v1.calls[0]!.url).toBe('https://myres.openai.azure.com/openai/v1/chat/completions')
    expect(v1.calls[0]!.body).toMatchObject({ model: 'gpt-prod' })

    const dated = fakeFetch(stream())
    vi.stubGlobal('fetch', dated.fetch)
    cfg.apiVersion = '2024-10-21'
    for await (const _event of createProvider(cfg, KEY).streamMessage(ask)) void _event
    expect(dated.calls[0]!.url).toBe('https://myres.openai.azure.com/openai/deployments/gpt-prod/chat/completions?api-version=2024-10-21')
    expect(dated.calls[0]!.headers['api-key']).toBe(KEY)
  })

  it('refuses a resource name that is an address, so the key never goes elsewhere', () => {
    const cfg = configFromPreset(presetById('azure')!, 'p')
    cfg.azureResource = 'https://evil.example.com/'
    expect(() => createProvider(cfg, KEY)).toThrow(/not a valid Azure resource name/)
  })
})

describe('the SDK-backed providers', () => {
  it('hands OpenAI its preset address and key', async () => {
    const cfg = configFromPreset(presetById('openai')!, 'p')
    const provider = createProvider(cfg, KEY)
    expect(sdk.openai[0]).toMatchObject({ baseURL: 'https://api.openai.com/v1', apiKey: KEY })
    expect(await provider.validateConfiguration()).toMatchObject({ ok: true })
  })

  it('hands Anthropic its preset address and key', async () => {
    const cfg = configFromPreset(presetById('anthropic')!, 'p')
    const provider = createProvider(cfg, KEY)
    expect(sdk.anthropic[0]).toMatchObject({ baseURL: 'https://api.anthropic.com', apiKey: KEY })
    expect(await provider.validateConfiguration()).toMatchObject({ ok: true })
  })
})

describe('the rest', () => {
  it('builds the offline demo without a key or an address', () => {
    expect(createProvider(configFromPreset(presetById('demo')!, 'd')).kind).toBe('mock')
  })

  it('builds a custom endpoint once it has an address', () => {
    const cfg = configFromPreset(presetById('custom')!, 'c')
    cfg.baseUrl = 'https://llm.example.com/v1'
    expect(createProvider(cfg).kind).toBe('openai-compat')
  })

  it('builds a custom JSON endpoint once it has an address', () => {
    const cfg = configFromPreset(presetById('custom-json')!, 'j')
    cfg.baseUrl = 'https://api.example.com/generate'
    expect(createProvider(cfg).kind).toBe('custom')
  })
})
