import { afterEach, describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../builders'
import { NormalizedAIError } from '../../types/errors'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import { collect, fakeFetch, jsonResponse, sseResponse } from '../gemini/testSupport'
import { createProvider } from '../factory'
import { OpenAICompatProvider } from '../openai-compat/OpenAICompatProvider'
import { AzureOpenAIProvider } from './AzureOpenAIProvider'

const KEY = 'azure-secret-key-0123456789abcdef'

/** What Azure streams: a content-filter frame with no choices first, usage with no choices last. */
const STREAM = [
  'data: {"choices":[],"created":0,"id":"","model":"","object":"","prompt_filter_results":[{"prompt_index":0,"content_filter_results":{}}]}\n\n',
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"},"finish_reason":null,"index":0}],"id":"chatcmpl-1","model":"gpt-4o-2024-08-06"}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null,"index":0}],"id":"chatcmpl-1"}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"id":"chatcmpl-1"}\n\n',
  'data: {"choices":[],"id":"chatcmpl-1","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  'data: [DONE]\n\n'
]

function azure(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'az',
    kind: 'openai-compat',
    apiMode: 'azure',
    name: 'Azure OpenAI',
    accessType: 'api',
    azureResource: 'myres',
    azureDeployments: ['gpt-4o-prod', 'o3-mini-eu'],
    defaultModel: 'gpt-4o-prod',
    // what the OpenAI-compatible form would send: the provider must not trust the scheme
    auth: { type: 'api_key', scheme: 'bearer' },
    enabled: true,
    ...overrides
  }
}

const ask = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  model: 'gpt-4o-prod',
  messages: [userMessage('hi')],
  ...overrides
})

/** The compat adapter reads `fetch` when it is built, so stub before constructing. */
function build(config: ProviderConfig, ...answers: Parameters<typeof fakeFetch>): { provider: AzureOpenAIProvider; calls: ReturnType<typeof fakeFetch>['calls'] } {
  const { fetch, calls } = fakeFetch(...answers)
  vi.stubGlobal('fetch', fetch)
  return { provider: new AzureOpenAIProvider(config, KEY), calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AzureOpenAIProvider: routes', () => {
  it('uses the v1 route by default: no deployment in the path, no api-version, the key in api-key', async () => {
    const { provider, calls } = build(azure(), sseResponse(STREAM))
    await collect(provider.streamMessage(ask({ params: { maxOutputTokens: 100 } })))

    const call = calls[0]!
    expect(call.url).toBe('https://myres.openai.azure.com/openai/v1/chat/completions')
    expect(call.method).toBe('POST')
    expect(call.headers['api-key']).toBe(KEY)
    expect(call.headers['authorization']).toBeUndefined()
    expect(call.url).not.toContain(KEY)
    expect(call.body).toMatchObject({ model: 'gpt-4o-prod', stream: true, max_completion_tokens: 100 })
    expect((call.body as Record<string, unknown>).max_tokens).toBeUndefined()
  })

  it('puts the deployment and api-version in the URL for a dated api-version', async () => {
    const { provider, calls } = build(azure({ apiVersion: '2024-10-21' }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask({ model: 'o3-mini-eu', params: { maxOutputTokens: 50 } })))
    expect(calls[0]!.url).toBe('https://myres.openai.azure.com/openai/deployments/o3-mini-eu/chat/completions?api-version=2024-10-21')
    expect(calls[0]!.headers['api-key']).toBe(KEY)
    expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 50 })
  })

  it('encodes a deployment name that needs it', async () => {
    const { provider, calls } = build(azure({ apiVersion: '2024-10-21' }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask({ model: 'my deploy/1' })))
    expect(calls[0]!.url).toContain('/deployments/my%20deploy%2F1/chat/completions?api-version=')
  })

  it('keeps max_tokens for an api-version from before max_completion_tokens existed', async () => {
    const { provider, calls } = build(azure({ apiVersion: '2024-06-01' }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask({ params: { maxOutputTokens: 64 } })))
    expect(calls[0]!.body).toMatchObject({ max_tokens: 64 })
    expect((calls[0]!.body as Record<string, unknown>).max_completion_tokens).toBeUndefined()
  })

  it.each([
    [{ baseUrl: 'https://myres.cognitiveservices.azure.com/' }, 'https://myres.cognitiveservices.azure.com/openai/v1/chat/completions'],
    [{ baseUrl: 'https://myres.openai.azure.com/openai/v1/' }, 'https://myres.openai.azure.com/openai/v1/chat/completions'],
    [{ baseUrl: 'https://myres.openai.azure.com/openai/deployments/x/chat/completions?api-version=2024-10-21' }, 'https://myres.openai.azure.com/openai/v1/chat/completions'],
    [{ baseUrl: 'https://myres.openai.azure.us' }, 'https://myres.openai.azure.us/openai/v1/chat/completions'],
    [{ baseUrl: 'https://apim.example.com/aoai' }, 'https://apim.example.com/aoai/openai/v1/chat/completions']
  ])('accepts a base URL override %j instead of the resource name', async (override, url) => {
    const { provider, calls } = build(azure({ azureResource: undefined, ...override }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.url).toBe(url)
  })

  it('lets the base URL win over a resource name', async () => {
    const { provider, calls } = build(azure({ baseUrl: 'https://other.openai.azure.com' }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.url).toBe('https://other.openai.azure.com/openai/v1/chat/completions')
  })

  it('treats a blank base URL as not set, as the provider form stores it', async () => {
    const { provider, calls } = build(azure({ baseUrl: '' }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.url).toBe('https://myres.openai.azure.com/openai/v1/chat/completions')
  })

  it('sends an Entra ID token as a bearer credential instead of api-key', async () => {
    const { provider, calls } = build(azure({ auth: { type: 'oauth', provider: 'microsoft' } }), sseResponse(STREAM))
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(calls[0]!.headers['api-key']).toBeUndefined()
  })
})

describe('AzureOpenAIProvider: configuration', () => {
  it('refuses a missing resource name', () => {
    expect(() => new AzureOpenAIProvider(azure({ azureResource: undefined }), KEY)).toThrow(NormalizedAIError)
    expect(() => new AzureOpenAIProvider(azure({ azureResource: '  ' }), KEY)).toThrow(/resource/i)
  })

  it.each(['evil.com/x', 'a b', 'res.openai.azure.com', '-bad', 'x'.repeat(70), 'my_res', 'https://myres'])(
    'refuses the resource name %j, because the key is sent to that host',
    (azureResource) => {
      expect(() => new AzureOpenAIProvider(azure({ azureResource }), KEY)).toThrow(NormalizedAIError)
    }
  )

  it('is still an openai-compat provider to the rest of the app', () => {
    const provider = new AzureOpenAIProvider(azure(), KEY)
    expect(provider.kind).toBe('openai-compat')
    expect(provider.id).toBe('az')
    expect(provider.name).toBe('Azure OpenAI')
  })
})

describe('AzureOpenAIProvider: models', () => {
  it('lists the configured deployments as the models, without a request', async () => {
    const { provider, calls } = build(azure(), jsonResponse({}))
    const models = await provider.getModels()
    expect(calls).toHaveLength(0)
    expect(models.map((m) => m.id)).toEqual(['gpt-4o-prod', 'o3-mini-eu'])
    expect(models[0]).toMatchObject({ providerId: 'az', location: 'cloud', supportsTools: true })
    expect(models[0]!.capabilities).toEqual(expect.arrayContaining(['tools', 'vision', 'image_input']))
  })

  it('adds the default model if it is not listed, and never repeats a name', async () => {
    const { provider } = build(azure({ azureDeployments: ['a', 'a', ' b '], defaultModel: 'c' }), jsonResponse({}))
    expect((await provider.getModels()).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('has no models until a deployment is named', async () => {
    const { provider } = build(azure({ azureDeployments: undefined, defaultModel: undefined }), jsonResponse({}))
    expect(await provider.getModels()).toEqual([])
  })

  it('honours declared capabilities, including reasoning for an o-series deployment', async () => {
    const { provider } = build(azure({ capabilities: ['text', 'streaming', 'reasoning'] }), jsonResponse({}))
    const [first] = await provider.getModels()
    expect(first!.supportsReasoning).toBe(true)
    expect(first!.supportsTools).toBe(false)
  })
})

describe('AzureOpenAIProvider: behaviour inherited from the compat adapter', () => {
  it('streams text and usage', async () => {
    const { provider } = build(azure(), sseResponse(STREAM))
    const events = await collect(provider.streamMessage(ask()))
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' }
    ])
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
  })

  it('accepts images by default (Azure deployments of vision models take them)', async () => {
    const { provider, calls } = build(azure(), sseResponse(STREAM))
    await collect(
      provider.streamMessage(
        ask({ messages: [userMessage([{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }])] })
      )
    )
    expect(calls).toHaveLength(1)
  })

  it('normalizes an Azure content filter 400', async () => {
    const { provider } = build(
      azure(),
      jsonResponse({ error: { code: 'content_filter', message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy." } }, { status: 400 })
    )
    await expect(collect(provider.streamMessage(ask()))).rejects.toMatchObject({ category: 'CONTENT_POLICY', retryable: false })
  })
})

describe('AzureOpenAIProvider.validateConfiguration', () => {
  it('checks the v1 models route with the api-key header', async () => {
    const { provider, calls } = build(azure(), jsonResponse({ data: [{ id: 'gpt-4o' }] }))
    const result = await provider.validateConfiguration()
    expect(calls[0]!.url).toBe('https://myres.openai.azure.com/openai/v1/models')
    expect(calls[0]!.headers['api-key']).toBe(KEY)
    expect(calls[0]!.url).not.toContain(KEY)
    expect(result).toMatchObject({ ok: true, details: { endpoint: 'https://myres.openai.azure.com', deployments: 2 } })
  })

  it('checks the dated models route with its api-version', async () => {
    const { provider, calls } = build(azure({ apiVersion: '2024-10-21' }), jsonResponse({ data: [] }))
    await provider.validateConfiguration()
    expect(calls[0]!.url).toBe('https://myres.openai.azure.com/openai/models?api-version=2024-10-21')
  })

  it('reports a rejected key as an authentication failure', async () => {
    const { provider } = build(
      azure(),
      jsonResponse({ error: { code: '401', message: 'Access denied due to invalid subscription key.' } }, { status: 401 })
    )
    expect(await provider.validateConfiguration()).toEqual({ ok: false, message: 'Authentication failed: check the API key.' })
  })

  it('reports an unreachable endpoint', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    const result = await new AzureOpenAIProvider(azure(), KEY).validateConfiguration()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not reachable at https:\/\/myres\.openai\.azure\.com/i)
  })
})

describe('createProvider: the azure mode', () => {
  it('builds the Azure adapter for openai-compat with apiMode azure', () => {
    const provider = createProvider(azure(), KEY)
    expect(provider).toBeInstanceOf(AzureOpenAIProvider)
    expect(provider.kind).toBe('openai-compat')
  })

  it('leaves a plain openai-compat provider alone', () => {
    const provider = createProvider(azure({ apiMode: undefined, baseUrl: 'https://example.test/v1' }), KEY)
    expect(provider).toBeInstanceOf(OpenAICompatProvider)
    expect(provider).not.toBeInstanceOf(AzureOpenAIProvider)
  })
})
