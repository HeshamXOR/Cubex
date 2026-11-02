import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@core/providers'
import { fakeFetch, jsonResponse } from '@core/providers/gemini/testSupport'
import {
  configFromPreset,
  presetById,
  presetFor,
  PROVIDER_PRESETS,
  type ProviderPreset
} from './providerPresets'

const KEY = 'preset-test-key-0123456789'

afterEach(() => vi.unstubAllGlobals())

describe('configFromPreset', () => {

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
})

describe('presetFor and endpointLabel', () => {
  it('finds a preset by what the provider connects to, whatever it is called', () => {
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' })?.id).toBe('groq')
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://API.Groq.com/openai/v1/' })?.id).toBe('groq')
    expect(presetFor({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' })?.id).toBe('ollama')
  })

  it('does not guess for a compatible endpoint it has never heard of', () => {
    expect(presetFor({ kind: 'openai-compat', baseUrl: 'https://llm.example.com/v1' })).toBeUndefined()
    expect(presetFor({ kind: 'openai-compat' })).toBeUndefined()
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
  }
)
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
