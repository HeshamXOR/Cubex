import { describe, expect, it } from 'vitest'
import { textPart, userMessage } from '../../builders'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import { NormalizedAIError } from '../../types/errors'
import { GEMINI_DEFAULT_BASE_URL, GeminiProvider } from './GeminiProvider'
import { collect, fakeFetch, fixtureText, jsonResponse, sseResponse } from './testSupport'

// A real Google API key is "AIza" plus 35 characters. This one is made up, and written in two pieces so
// that secret scanners do not mistake it for a leaked key.
const KEY = ['AIza', 'SyTESTKEY01234567890123456789012345'].join('')

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'gem', kind: 'gemini', name: 'Gemini', accessType: 'api', auth: { type: 'api_key' }, enabled: true, ...overrides }
}

const ask = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  model: 'gemini-2.5-flash',
  messages: [userMessage('hi')],
  ...overrides
})

const googleError = (code: number, status: string, message: string, details?: unknown[]): unknown => ({
  error: { code, message, status, ...(details ? { details } : {}) }
})

function chunked(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

describe('GeminiProvider: identity', () => {
  it('uses a test key shaped like a real one, so the redaction tests mean something', () => {
    expect(KEY).toMatch(/^AIza[0-9A-Za-z_-]{35}$/)
  })

  it('is a gemini provider with the capabilities of the API', () => {
    const provider = new GeminiProvider(cfg(), KEY)
    expect(provider.kind).toBe('gemini')
    expect(provider.id).toBe('gem')
    expect(provider.name).toBe('Gemini')
    for (const capability of ['text', 'streaming', 'tools', 'vision', 'reasoning', 'usage_reporting', 'cancellation'] as const) {
      expect(provider.supports(capability)).toBe(true)
    }
  })

  it('honours declared capabilities', () => {
    const provider = new GeminiProvider(cfg({ capabilities: ['text', 'streaming'] }), KEY)
    expect(provider.supports('tools')).toBe(false)
    expect(provider.supports('reasoning')).toBe(false)
  })

  it('defaults to the public endpoint', () => {
    expect(GEMINI_DEFAULT_BASE_URL).toBe('https://generativelanguage.googleapis.com')
  })
})

describe('GeminiProvider.streamMessage: request', () => {
  it('posts to streamGenerateContent as SSE and authenticates by header, never by URL', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    await collect(provider.streamMessage(ask()))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(call.url).not.toContain(KEY)
    expect(call.url).not.toMatch(/key=/i)
    expect(call.method).toBe('POST')
    expect(call.headers['x-goog-api-key']).toBe(KEY)
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.headers['authorization']).toBeUndefined()
    expect(call.body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
  })

  it('sends the translated request: system, tools and sampling', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    await collect(
      provider.streamMessage(
        ask({
          system: 'Be brief.',
          tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
          params: { temperature: 0.3, maxOutputTokens: 200 }
        })
      )
    )
    expect(calls[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read' }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 200 }
    })
  })

  it('honours a base URL override and API version, without doubling the version', async () => {
    const urls: string[] = []
    const run = async (config: Partial<ProviderConfig>, model = 'gemini-2.5-flash'): Promise<void> => {
      const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
      await collect(new GeminiProvider(cfg(config), KEY, { fetch }).streamMessage(ask({ model })))
      urls.push(calls[0]!.url)
    }
    await run({ baseUrl: 'https://proxy.test/gemini/', apiVersion: 'v1' })
    await run({ baseUrl: 'https://proxy.test/v1beta' })
    await run({ baseUrl: 'https://proxy.test/' }, 'models/gemini-2.5-pro')
    await run({}, 'tunedModels/my-tune-123')
    expect(urls).toEqual([
      'https://proxy.test/gemini/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      'https://proxy.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      'https://proxy.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      'https://generativelanguage.googleapis.com/v1beta/tunedModels/my-tune-123:streamGenerateContent?alt=sse'
    ])
  })

  it.each(['', '   '])('treats a blank base URL (%j) as not set, as the provider form stores it', async (baseUrl) => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    await collect(new GeminiProvider(cfg({ baseUrl }), KEY, { fetch }).streamMessage(ask()))
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  })

  it('merges configured and per-call headers but never forwards harness-only ones', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg({ headers: { 'x-team': 'core' } }), KEY, { fetch })
    await collect(provider.streamMessage(ask(), { headers: { 'x-cubex-long-context': '1', 'x-trace': 't1' } }))
    expect(calls[0]!.headers['x-team']).toBe('core')
    expect(calls[0]!.headers['x-trace']).toBe('t1')
    expect(calls[0]!.headers['x-cubex-long-context']).toBeUndefined()
  })

  it('cannot be overridden into sending the key somewhere else', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg({ headers: { 'x-goog-api-key': 'stale' } }), KEY, { fetch })
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY)
  })

  it('sends an OAuth token as a bearer credential instead', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg({ auth: { type: 'oauth', provider: 'google' } }), 'ya29.token', { fetch })
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.headers['authorization']).toBe('Bearer ya29.token')
    expect(calls[0]!.headers['x-goog-api-key']).toBeUndefined()
  })

  it('refuses to call out without a key, and says why', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg(), undefined, { fetch })
    await expect(collect(provider.streamMessage(ask()))).rejects.toMatchObject({ category: 'AUTHENTICATION_ERROR', retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('allows a keyless endpoint when auth is none (a local proxy)', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg({ auth: { type: 'none' }, baseUrl: 'http://127.0.0.1:9000' }), undefined, { fetch })
    await collect(provider.streamMessage(ask()))
    expect(calls[0]!.headers['x-goog-api-key']).toBeUndefined()
  })

  it('does not send a tool-using request to Gemma, which cannot call functions', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    await expect(
      collect(provider.streamMessage(ask({ model: 'gemma-3-27b-it', tools: [{ name: 't', inputSchema: { type: 'object' } }] })))
    ).rejects.toMatchObject({ category: 'INVALID_REQUEST' })
    expect(calls).toHaveLength(0)
  })
})

describe('GeminiProvider.streamMessage: reasoning effort', () => {
  const sent = async (model: string, reasoningEffort: NonNullable<AIRequest['params']>['reasoningEffort']): Promise<unknown> => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    await collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask({ model, params: { reasoningEffort } })))
    return (calls[0]!.body as { generationConfig?: { thinkingConfig?: unknown } }).generationConfig?.thinkingConfig
  }

  it('sends thinkingBudget to Gemini 2.5 and always asks for thought summaries', async () => {
    expect(await sent('gemini-2.5-flash', 'medium')).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
    expect(await sent('gemini-2.5-flash', 'minimal')).toEqual({ includeThoughts: true, thinkingBudget: 0 })
    expect(await sent('gemini-2.5-flash', undefined)).toEqual({ includeThoughts: true })
  })

  it('sends thinkingLevel to Gemini 3, only a level the model accepts', async () => {
    expect(await sent('gemini-3-flash-preview', 'high')).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
    expect(await sent('gemini-3-pro-preview', 'minimal')).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    expect(await sent('gemini-3.7-flash', 'minimal')).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
  })

  it('maps an effort the model has no equivalent for to the closest it has', async () => {
    expect(await sent('gemini-2.5-flash', 'xhigh')).toEqual({ includeThoughts: true, thinkingBudget: 24576 })
    expect(await sent('gemini-3.1-pro-preview', 'max')).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
  })

  it('sends no thinking config to a model that does not think', async () => {
    expect(await sent('gemini-2.0-flash', 'high')).toBeUndefined()
  })
})

describe('GeminiProvider.streamMessage: events', () => {
  it('streams a recorded thinking and function call response', async () => {
    const { fetch } = fakeFetch(sseResponse([fixtureText('thinking-function-call')]))
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    const events = await collect(provider.streamMessage(ask({ model: 'gemini-3-flash-preview' })))
    expect(events.map((e) => (e.type === 'metadata' ? 'signature' : e.type))).toEqual([
      'start',
      'reasoning_delta',
      'reasoning_delta',
      'tool_call',
      'signature',
      'stop',
      'usage'
    ])
    expect(events[0]).toMatchObject({ type: 'start', provider: 'gem', model: 'gemini-3-flash-preview' })
  })

  it('is indifferent to how the network splits the stream, even mid-frame', async () => {
    const text = fixtureText('thinking-function-call')
    const whole = await collect(new GeminiProvider(cfg(), KEY, { fetch: fakeFetch(sseResponse([text])).fetch }).streamMessage(ask({ model: 'gemini-3-flash-preview' })))
    for (const size of [1, 7, 41, 300]) {
      const events = await collect(
        new GeminiProvider(cfg(), KEY, { fetch: fakeFetch(sseResponse(chunked(text, size))).fetch }).streamMessage(ask({ model: 'gemini-3-flash-preview' }))
      )
      expect(events).toEqual(whole)
    }
  })

  it('accepts CRLF frame separators, as the live API sends them', async () => {
    const crlf = fixtureText('plain-text').replace(/\n/g, '\r\n')
    const { fetch } = fakeFetch(sseResponse([crlf]))
    const events = await collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3)
  })

  it('delivers the text streamed before a mid-stream failure, then the failure', async () => {
    const { fetch } = fakeFetch(sseResponse([fixtureText('mid-stream-error')]))
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    const events: AIStreamEvent[] = []
    let error: unknown
    try {
      for await (const event of provider.streamMessage(ask())) events.push(event)
    } catch (caught) {
      error = caught
    }
    expect(events).toContainEqual({ type: 'text_delta', text: 'Partial answer' })
    expect(error).toBeInstanceOf(NormalizedAIError)
    expect(error).toMatchObject({ category: 'SERVER_ERROR', retryable: true })
  })

  it('fails a blocked prompt as a content policy error', async () => {
    const { fetch } = fakeFetch(sseResponse([fixtureText('prompt-blocked')]))
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))).rejects.toMatchObject({
      category: 'CONTENT_POLICY',
      retryable: false
    })
  })
})

describe('GeminiProvider.streamMessage: HTTP failures', () => {
  const failWith = async (status: number, body: unknown, headers?: Record<string, string>): Promise<NormalizedAIError> => {
    const { fetch } = fakeFetch(jsonResponse(body, { status, ...(headers ? { headers } : {}) }))
    try {
      await collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))
    } catch (error) {
      return error as NormalizedAIError
    }
    throw new Error('did not fail')
  }

  it('turns 429 RESOURCE_EXHAUSTED into a retryable rate limit with the delay asked for', async () => {
    const error = await failWith(
      429,
      googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }
      ])
    )
    expect(error).toBeInstanceOf(NormalizedAIError)
    expect(error).toMatchObject({ category: 'RATE_LIMIT_ERROR', retryable: true, retryAfterMs: 34_000, statusCode: 429, provider: 'gem' })
  })

  it('turns 503 UNAVAILABLE into a retryable server error', async () => {
    const error = await failWith(503, googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'))
    expect(error).toMatchObject({ category: 'SERVER_ERROR', retryable: true, statusCode: 503 })
  })

  it('turns the 400 a bad key produces into an authentication error', async () => {
    const error = await failWith(
      400,
      googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }
      ])
    )
    expect(error).toMatchObject({ category: 'AUTHENTICATION_ERROR', retryable: false })
  })

  it('never carries the key or request details in the error', async () => {
    const error = await failWith(403, googleError(403, 'PERMISSION_DENIED', `Key ${KEY} is not allowed`))
    expect(error.message).not.toContain(KEY)
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY)
    expect(error.cause).toBeUndefined()
  })

  it('reports a network failure as retryable', async () => {
    const fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    }) as unknown as typeof globalThis.fetch
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))).rejects.toMatchObject({
      category: 'NETWORK_ERROR',
      retryable: true
    })
  })
})

describe('GeminiProvider.streamMessage: cancellation', () => {
  it('is cancelled before it starts when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    const abort = new AbortController()
    abort.abort()
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask(), { signal: abort.signal }))).rejects.toMatchObject({
      category: 'CANCELLED'
    })
    expect(calls).toHaveLength(0)
  })

  it('stops with a cancelled error, not a normal end, when aborted mid-stream', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      }
    })
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }))
    const abort = new AbortController()
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    const events: AIStreamEvent[] = []
    const done = (async () => {
      for await (const event of provider.streamMessage(ask(), { signal: abort.signal })) events.push(event)
    })()
    const settled = done.then(
      () => 'finished',
      (error: unknown) => error
    )
    source.enqueue(new TextEncoder().encode(fixtureText('plain-text').split('\n\n')[0] + '\n\n'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    const outcome = await settled
    expect(outcome).toBeInstanceOf(NormalizedAIError)
    expect(outcome).toMatchObject({ category: 'CANCELLED' })
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
  })
})

describe('GeminiProvider.sendMessage', () => {
  const reply = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { text: 'Need the file.', thought: true },
            { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'SIG-1' }
          ]
        },
        finishReason: 'STOP',
        index: 0
      }
    ],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 45 },
    modelVersion: 'gemini-3-flash-preview',
    responseId: 'resp-1'
  }

  it('calls generateContent (not the stream route) and builds the response', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(reply))
    const response = await new GeminiProvider(cfg(), KEY, { fetch }).sendMessage(ask({ model: 'gemini-3-flash-preview' }))

    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent')
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY)
    expect(response.provider).toBe('gem')
    expect(response.model).toBe('gemini-3-flash-preview')
    expect(response.stopReason).toBe('tool_use')
    expect(response.requestId).toBe('resp-1')
    expect(response.toolCalls).toMatchObject([{ name: 'read_file', input: { path: 'a.ts' } }])
    expect(response.usage).toEqual({ inputTokens: 30, outputTokens: 15, reasoningTokens: 5, totalTokens: 45 })
    // the signature is kept in order, right after the call it signs
    expect(response.content.map((part) => part.type)).toEqual(['reasoning', 'tool_use', 'reasoning'])
    expect(response.content[2]).toMatchObject({ type: 'reasoning', text: '', signature: 'gemini:SIG-1' })
  })

  it('returns plain text answers', async () => {
    const { fetch } = fakeFetch(
      jsonResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        responseId: 'r2'
      })
    )
    const response = await new GeminiProvider(cfg(), KEY, { fetch }).sendMessage(ask())
    expect(response.text).toBe('Hello.')
    expect(response.stopReason).toBe('stop')
  })

  it('rejects a blocked prompt and an HTTP failure with normalized errors', async () => {
    const blocked = fakeFetch(jsonResponse({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4 } }))
    await expect(new GeminiProvider(cfg(), KEY, { fetch: blocked.fetch }).sendMessage(ask())).rejects.toMatchObject({ category: 'CONTENT_POLICY' })

    const down = fakeFetch(jsonResponse(googleError(503, 'UNAVAILABLE', 'overloaded'), { status: 503 }))
    await expect(new GeminiProvider(cfg(), KEY, { fetch: down.fetch }).sendMessage(ask())).rejects.toMatchObject({
      category: 'SERVER_ERROR',
      retryable: true
    })
  })
})

describe('GeminiProvider.getModels', () => {
  const model = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: `models/${name}`,
    displayName: name,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ['generateContent', 'countTokens'],
    ...extra
  })

  it('lists chat models: filtered by generation method, limits mapped, newest first', async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({
        models: [
          model('gemini-2.5-flash', { displayName: 'Gemini 2.5 Flash', thinking: true }),
          model('gemini-3.1-pro-preview', { displayName: 'Gemini 3.1 Pro Preview', thinking: true, inputTokenLimit: 1_000_000, outputTokenLimit: 64_000 }),
          model('gemini-2.0-flash', { thinking: false, outputTokenLimit: 8192 }),
          model('text-embedding-004', { supportedGenerationMethods: ['embedContent'] }),
          model('gemini-2.5-flash-preview-tts'),
          model('gemini-2.5-flash-image'),
          model('gemini-flash-latest', { thinking: true }),
          model('gemma-3-27b-it', { outputTokenLimit: 8192 })
        ]
      })
    )
    const models = await new GeminiProvider(cfg(), KEY, { fetch }).getModels()

    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(calls[0]!.url).not.toContain(KEY)
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY)
    expect(models.map((m) => m.id)).toEqual(['gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemma-3-27b-it'])

    const pro = models[0]!
    expect(pro).toMatchObject({
      providerId: 'gem',
      displayName: 'Gemini 3.1 Pro Preview',
      location: 'cloud',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      supportsTools: true,
      supportsReasoning: true,
      family: 'gemini-3.1'
    })
    expect(pro.capabilities).toEqual(expect.arrayContaining(['tools', 'reasoning', 'vision', 'streaming']))
    expect(pro.modalities.input).toEqual(expect.arrayContaining(['text', 'image', 'audio', 'video']))

    const flash20 = models.find((m) => m.id === 'gemini-2.0-flash')!
    expect(flash20.supportsReasoning).toBe(false)
    expect(flash20.capabilities).not.toContain('reasoning')
    expect(models.find((m) => m.id === 'gemma-3-27b-it')).toMatchObject({ supportsTools: false })
  })

  it('infers thinking from the id when the API does not say', async () => {
    const { fetch } = fakeFetch(jsonResponse({ models: [model('gemini-2.5-pro'), model('gemini-1.5-pro')] }))
    const models = await new GeminiProvider(cfg(), KEY, { fetch }).getModels()
    expect(models.find((m) => m.id === 'gemini-2.5-pro')!.supportsReasoning).toBe(true)
    expect(models.find((m) => m.id === 'gemini-1.5-pro')!.supportsReasoning).toBe(false)
  })

  it('follows pagination', async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ models: [model('gemini-2.5-flash')], nextPageToken: 'page2' }),
      jsonResponse({ models: [model('gemini-2.5-pro')] })
    )
    const models = await new GeminiProvider(cfg(), KEY, { fetch }).getModels()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page2')
    expect(models.map((m) => m.id).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
  })

  it('remembers which models think, so a tuned model that does gets thought summaries', async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ models: [model('tunedish-model', { thinking: true })] }),
      sseResponse([fixtureText('plain-text')])
    )
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    await provider.getModels()
    await collect(provider.streamMessage(ask({ model: 'tunedish-model' })))
    expect((calls[1]!.body as { generationConfig?: unknown }).generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } })
  })

  it('falls back to the stable models when the list cannot be fetched, without throwing', async () => {
    const { fetch } = fakeFetch(jsonResponse(googleError(503, 'UNAVAILABLE', 'down'), { status: 503 }))
    const models = await new GeminiProvider(cfg(), KEY, { fetch }).getModels()
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']))
    expect(models[0]!.notes).toMatch(/fallback/i)
  })
})

describe('GeminiProvider.validateConfiguration', () => {
  it('accepts a working key and reports the endpoint and model count', async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] })
    )
    const result = await new GeminiProvider(cfg(), KEY, { fetch }).validateConfiguration()
    expect(result.ok).toBe(true)
    expect(result.details).toMatchObject({ models: 1 })
    expect(calls[0]!.url).not.toContain(KEY)
  })

  it('reports a rejected key as an authentication failure', async () => {
    const { fetch } = fakeFetch(
      jsonResponse(
        googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }
        ]),
        { status: 400 }
      )
    )
    const result = await new GeminiProvider(cfg(), KEY, { fetch }).validateConfiguration()
    expect(result).toEqual({ ok: false, message: 'Authentication failed: check the API key.' })
  })

  it('reports an unreachable endpoint', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const result = await new GeminiProvider(cfg(), KEY, { fetch }).validateConfiguration()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not reachable/i)
  })

  it('asks for a key instead of making a doomed request', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ models: [] }))
    const result = await new GeminiProvider(cfg(), undefined, { fetch }).validateConfiguration()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/api key/i)
    expect(calls).toHaveLength(0)
  })
})

describe('GeminiProvider: text parts', () => {
  it('keeps text-part uploads as text', async () => {
    const { fetch, calls } = fakeFetch(sseResponse([fixtureText('plain-text')]))
    await collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask({ messages: [userMessage([textPart('a'), textPart('b')])] })))
    expect((calls[0]!.body as { contents: unknown[] }).contents).toEqual([{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }])
  })
})

describe('GeminiProvider: repairs for what the API says it cannot take', () => {
  const refuse = (message: string) => jsonResponse(googleError(400, 'INVALID_ARGUMENT', message), { status: 400 })
  const thinkingOf = (call: { body: unknown }): unknown => (call.body as { generationConfig?: { thinkingConfig?: unknown } }).generationConfig?.thinkingConfig

  it('asks again without thinking when the model refuses it, and remembers for that model', async () => {
    const { fetch, calls } = fakeFetch(
      refuse('Thinking level MINIMAL is not supported for this model.'),
      sseResponse([fixtureText('plain-text')]),
      sseResponse([fixtureText('plain-text')])
    )
    const provider = new GeminiProvider(cfg(), KEY, { fetch })
    const events = await collect(provider.streamMessage(ask({ model: 'gemini-3-flash-preview', params: { reasoningEffort: 'minimal' } })))

    expect(calls).toHaveLength(2)
    expect(thinkingOf(calls[0]!)).toEqual({ includeThoughts: true, thinkingLevel: 'minimal' })
    expect(thinkingOf(calls[1]!)).toBeUndefined()
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3)

    await collect(provider.streamMessage(ask({ model: 'gemini-3-flash-preview', params: { reasoningEffort: 'high' } })))
    expect(calls).toHaveLength(3)
    expect(thinkingOf(calls[2]!)).toBeUndefined()
  })

  it('repairs a non-streaming call the same way', async () => {
    const { fetch, calls } = fakeFetch(
      refuse('Budget 0 is invalid. This model only works in thinking mode.'),
      jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], responseId: 'r' })
    )
    const response = await new GeminiProvider(cfg(), KEY, { fetch }).sendMessage(ask({ params: { reasoningEffort: 'minimal' } }))
    expect(response.text).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(thinkingOf(calls[1]!)).toBeUndefined()
  })

  it('does not retry an error that is not about thinking', async () => {
    const { fetch, calls } = fakeFetch(refuse('Invalid JSON payload received. Unknown name "x".'), sseResponse([fixtureText('plain-text')]))
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))).rejects.toMatchObject({ category: 'INVALID_REQUEST' })
    expect(calls).toHaveLength(1)
  })

  it('does not retry when no thinking config was sent', async () => {
    const { fetch, calls } = fakeFetch(refuse('Thinking is not supported.'), sseResponse([fixtureText('plain-text')]))
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask({ model: 'gemini-2.0-flash' })))).rejects.toMatchObject({
      category: 'INVALID_REQUEST'
    })
    expect(calls).toHaveLength(1)
  })

  it('tries only once more: a second refusal is the error', async () => {
    const { fetch, calls } = fakeFetch(refuse('Thinking is not supported for this model.'), refuse('Request is invalid.'))
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))).rejects.toMatchObject({ category: 'INVALID_REQUEST' })
    expect(calls).toHaveLength(2)
  })

  it('asks again without signatures when the API rejects one, marking Gemini 3 calls as not model-made', async () => {
    const { fetch, calls } = fakeFetch(refuse('Corrupted thought signature.'), sseResponse([fixtureText('plain-text')]))
    const messages: AIRequest['messages'] = [
      userMessage('read it'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'gemini_call_aaaaaaaaaaaaaaaa', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'reasoning', text: '', signature: 'gemini:STALE-SIGNATURE' }
        ]
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'gemini_call_aaaaaaaaaaaaaaaa', content: [textPart('body')] }] }
    ]
    await collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask({ model: 'gemini-3-flash-preview', messages })))

    const parts = (call: { body: unknown }): Array<{ thoughtSignature?: string }> => (call.body as { contents: Array<{ parts: Array<{ thoughtSignature?: string }> }> }).contents[1]!.parts
    expect(calls).toHaveLength(2)
    expect(parts(calls[0]!)[0]!.thoughtSignature).toBe('STALE-SIGNATURE')
    expect(parts(calls[1]!)[0]!.thoughtSignature).toBe('skip_thought_signature_validator')
  })

  it('does not retry a signature complaint when there was no signature to remove', async () => {
    const { fetch, calls } = fakeFetch(refuse('Corrupted thought signature.'), sseResponse([fixtureText('plain-text')]))
    await expect(collect(new GeminiProvider(cfg(), KEY, { fetch }).streamMessage(ask()))).rejects.toMatchObject({ category: 'INVALID_REQUEST' })
    expect(calls).toHaveLength(1)
  })
})
