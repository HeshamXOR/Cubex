import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import { userMessage } from '../../builders'
import { AnthropicProvider } from '../anthropic/AnthropicProvider'
import type { ModelEndpoint } from '../endpoints'
import { OpenAIProvider } from '../openai/OpenAIProvider'
import { OpenAICompatProvider } from './OpenAICompatProvider'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'gw', kind: 'openai-compat', name: 'Gateway', accessType: 'api', baseUrl: 'https://gateway.test/v1', auth: { type: 'api_key', scheme: 'bearer' }, enabled: true, ...overrides }
}

const ask = (model: string): AIRequest => ({ model, messages: [userMessage('hi')] })
const sse = (...frames: string[]): Response => new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), { status: 200 })
const chatOk = (): Response => sse('{"choices":[{"delta":{"content":"via chat"},"finish_reason":"stop"}]}', '[DONE]')
const fail = (status: number, message: string): Response => new Response(JSON.stringify({ error: { message } }), { status })

async function collect(provider: { streamMessage: (r: AIRequest) => AsyncIterable<AIStreamEvent> }, request: AIRequest): Promise<string> {
  let text = ''
  for await (const event of provider.streamMessage(request)) if (event.type === 'text_delta') text += event.text
  return text
}

/** Stand-ins for the other two formats, so a test can see which one a request reached. */
function stubDelegates() {
  const answer = (label: string) => async function* (): AsyncIterable<AIStreamEvent> {
    yield { type: 'text_delta', text: `via ${label}` }
    yield { type: 'stop', stopReason: 'stop' }
  }
  const anthropic = vi.spyOn(AnthropicProvider.prototype, 'streamMessage').mockImplementation(answer('anthropic') as never)
  const responses = vi.spyOn(OpenAIProvider.prototype, 'streamMessage').mockImplementation(answer('responses') as never)
  return { anthropic, responses }
}

const known = (endpoints: ModelEndpoint[]) => (id: string) => ({ id, endpoints })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('routing each model on a gateway', () => {
  it('sends Claude to the Messages API, GPT to Responses and the rest to Chat Completions', async () => {
    const { anthropic, responses } = stubDelegates()
    vi.stubGlobal('fetch', vi.fn(async () => chatOk()))
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', known(['chat', 'responses', 'anthropic']))
    expect(await collect(provider, ask('claude-sonnet-5-5'))).toBe('via anthropic')
    expect(await collect(provider, ask('gpt-6.1-sol'))).toBe('via responses')
    expect(await collect(provider, ask('glm-5.3-flash'))).toBe('via chat')
    expect(anthropic).toHaveBeenCalledTimes(1)
    expect(responses).toHaveBeenCalledTimes(1)
  })

  it('moves to the next endpoint at once when one is busy, before any output', async () => {
    stubDelegates()
    const fetchMock = vi.fn(async () => fail(503, 'The service is temporarily busy.'))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', known(['chat', 'responses']))
    expect(await collect(provider, ask('glm-5.3-flash'))).toBe('via responses')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports busy when every endpoint is busy, so the gateway can wait and retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(503, 'The service is temporarily busy.')))
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', known(['chat']))
    await expect(collect(provider, ask('glm-5.3-flash'))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('follows a refusal in the other direction, away from Responses', async () => {
    const { responses } = stubDelegates()
    responses.mockImplementation((() => {
      throw Object.assign(new Error('The model is not available on this endpoint. Use: /v1/chat/completions, /v1/messages.'), {})
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async () => chatOk()))
    const refused = new Error('x')
    void refused
    responses.mockImplementation(async function* () {
      const { NormalizedAIError } = await import('../../types/errors')
      throw new NormalizedAIError({ provider: 'gw', category: 'INVALID_REQUEST', statusCode: 400, message: 'The model `gpt-5.4` is not available on this endpoint. Use: /v1/chat/completions.', classification: 'permanent', retryable: false })
    } as never)
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', known(['responses', 'chat']))
    expect(await collect(provider, ask('gpt-5.4'))).toBe('via chat')
    expect(await collect(provider, ask('gpt-5.4'))).toBe('via chat')
    expect(responses).toHaveBeenCalledTimes(1)
  })

  it('forgets a refusal after a while, because a gateway moves models between its upstreams', async () => {
    const { responses } = stubDelegates()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fail(400, 'Use POST /v1/responses instead.')).mockResolvedValue(chatOk()))
    const provider = new OpenAICompatProvider(cfg(), 'k')
    expect(await collect(provider, ask('m'))).toBe('via responses')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
    expect(await collect(provider, ask('m'))).toBe('via chat')
    expect(responses).toHaveBeenCalledTimes(1)
  })

  it('on a server that lists nothing, tries Claude on the Messages API and falls back for good on a 404', async () => {
    const { anthropic } = stubDelegates()
    anthropic.mockImplementation(async function* () {
      const { NormalizedAIError } = await import('../../types/errors')
      throw new NormalizedAIError({ provider: 'gw', category: 'MODEL_NOT_FOUND', statusCode: 404, message: 'Not found', classification: 'permanent', retryable: false })
    } as never)
    vi.stubGlobal('fetch', vi.fn(async () => chatOk()))
    const provider = new OpenAICompatProvider(cfg(), 'k')
    expect(await collect(provider, ask('claude-sonnet-5-5'))).toBe('via chat')
    expect(await collect(provider, ask('claude-sonnet-5-5'))).toBe('via chat')
    expect(anthropic).toHaveBeenCalledTimes(1)
  })

  it('keeps to the format the person chose', async () => {
    const { anthropic, responses } = stubDelegates()
    vi.stubGlobal('fetch', vi.fn(async () => chatOk()))
    const provider = new OpenAICompatProvider(cfg({ apiMode: 'chat_completions' }), 'k', 'openai-compat', known(['chat', 'responses', 'anthropic']))
    expect(await collect(provider, ask('claude-sonnet-5-5'))).toBe('via chat')
    expect(anthropic).not.toHaveBeenCalled()
    expect(responses).not.toHaveBeenCalled()
  })

  it('never retries once part of the reply has been shown', async () => {
    const { anthropic } = stubDelegates()
    anthropic.mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'half' }
      const { NormalizedAIError } = await import('../../types/errors')
      throw new NormalizedAIError({ provider: 'gw', category: 'SERVER_ERROR', statusCode: 503, message: 'busy', classification: 'transient', retryable: true })
    } as never)
    const fetchMock = vi.fn(async () => chatOk())
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', known(['anthropic', 'chat']))
    await expect(collect(provider, ask('claude-opus-5-5'))).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('reading the model list', () => {
  it('reports each model\'s endpoints and the gateway\'s price, and leaves out image models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [
          { id: 'gpt-5.4', supported_endpoint_types: ['openai', 'openai-response'] },
          { id: 'flux.2-pro', supported_endpoint_types: ['image-generation'] }
        ] }))
      }
      if (url === 'https://gateway.test/api/pricing') {
        return new Response(JSON.stringify({ group_ratio: { default: 1 }, data: [{ model_name: 'gpt-5.4', quota_type: 0, model_ratio: 1.25, completion_ratio: 6, cache_ratio: 0.1 }] }))
      }
      return new Response('', { status: 404 })
    }))
    const models = await new OpenAICompatProvider(cfg(), 'k').getModels()
    expect(models.map((model) => model.id)).toEqual(['gpt-5.4'])
    expect(models[0]).toMatchObject({ endpoints: ['chat', 'responses'], pricing: { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, source: 'provider' } })
  })

  it('asks the list once before the first request when nothing else has', async () => {
    const { anthropic } = stubDelegates()
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'claude-x-5', supported_endpoint_types: ['anthropic'] }] }))
      : chatOk()))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatProvider(cfg(), 'k', 'openai-compat', undefined, true)
    expect(await collect(provider, ask('claude-x-5'))).toBe('via anthropic')
    expect(await collect(provider, ask('claude-x-5'))).toBe('via anthropic')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(anthropic).toHaveBeenCalledTimes(2)
  })
})

describe('a stream that stops early', () => {
  it('counts as a failure, not a finished answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse('{"choices":[{"delta":{"content":"half an ans"}}]}')))
    await expect(collect(new OpenAICompatProvider(cfg(), 'k'), ask('m'))).rejects.toMatchObject({ category: 'STREAM_ERROR', classification: 'transient' })
  })

  it('is fine when the server said [DONE], with or without a finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse('{"choices":[{"delta":{"content":"whole"}}]}', '[DONE]')))
    expect(await collect(new OpenAICompatProvider(cfg(), 'k'), ask('m'))).toBe('whole')
  })
})
