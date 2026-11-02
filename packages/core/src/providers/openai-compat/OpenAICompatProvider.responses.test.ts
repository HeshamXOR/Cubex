import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from './OpenAICompatProvider'
import { AzureOpenAIProvider } from '../azure/AzureOpenAIProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'

const sdk = vi.hoisted(() => ({ responses: vi.fn(), options: [] as Array<Record<string, any>> }))
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  return {
    ...actual,
    default: class {
      constructor(options: Record<string, any>) { sdk.options.push(options) }
      responses = { create: sdk.responses }
    }
  }
})

const REFUSAL = '{"error":{"message":"/v1/chat/completions does not work for this model. Use POST /v1/responses instead."}}'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'compat', kind: 'openai-compat', name: 'Compat', accessType: 'api', baseUrl: 'https://gateway.test/v1',
    auth: { type: 'api_key', scheme: 'bearer' }, enabled: true, ...overrides
  }
}

const chatAnswer = () => new Response(
  'data: {"choices":[{"delta":{"content":"via chat"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  { status: 200 }
)
const refusal = (status = 400, body = REFUSAL) => new Response(body, { status })

const responsesAnswer = () => (async function* () {
  yield { type: 'response.created', response: { id: 'resp-1' } }
  yield { type: 'response.output_text.delta', delta: 'via responses' }
  yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } } }
})()

const ask = (model = 'glm-5.3-flash', extra: Partial<AIRequest> = {}): AIRequest => ({ model, messages: [userMessage('hi')], ...extra })

async function textOf(provider: { streamMessage: (r: AIRequest) => AsyncIterable<AIStreamEvent> }, request: AIRequest): Promise<string> {
  let text = ''
  for await (const event of provider.streamMessage(request)) if (event.type === 'text_delta') text += event.text
  return text
}

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); sdk.options.length = 0 })

describe('OpenAICompatProvider and the Responses API', () => {
  it('retries once through Responses when the server turns chat/completions away, and remembers it for the model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValue(chatAnswer())
    vi.stubGlobal('fetch', fetchMock)
    sdk.responses.mockImplementation(async () => responsesAnswer())
    const provider = new OpenAICompatProvider(cfg(), 'secret')

    expect(await textOf(provider, ask())).toBe('via responses')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sdk.responses).toHaveBeenCalledTimes(1)
    expect(sdk.responses.mock.calls[0]![0]).toMatchObject({ model: 'glm-5.3-flash', stream: true })

    expect(await textOf(provider, ask())).toBe('via responses')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sdk.responses).toHaveBeenCalledTimes(2)

    // Only that model moved; the host's other models still use Chat Completions.
    expect(await textOf(provider, ask('other-model'))).toBe('via chat')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sdk.responses).toHaveBeenCalledTimes(2)
  })

  it('does not switch for a 400 that is about something else', async () => {
    const fetchMock = vi.fn(async () => refusal(400, '{"error":{"message":"max_tokens is too large"}}'))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    await expect(textOf(provider, ask())).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sdk.responses).not.toHaveBeenCalled()
  })

  it('goes straight to Responses when apiMode asks for it, with the chosen auth, headers and effort', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    sdk.responses.mockImplementation(async () => responsesAnswer())
    const provider = new OpenAICompatProvider(
      cfg({ apiMode: 'responses', auth: { type: 'api_key', scheme: 'raw', headerName: 'x-gateway-key' }, headers: { 'X-Team': 'blue' }, capabilities: ['text', 'streaming', 'tools', 'reasoning'] }),
      'secret',
      'openai-compat',
      () => ({ id: 'glm-5.3-flash', supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] })
    )
    expect(provider.supports('reasoning')).toBe(true)
    expect(await textOf(provider, ask('glm-5.3-flash', { params: { reasoningEffort: 'xhigh' } }))).toBe('via responses')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sdk.options[0]).toMatchObject({ baseURL: 'https://gateway.test/v1', defaultHeaders: { Authorization: null, 'x-gateway-key': 'secret', 'X-Team': 'blue' } })
    expect(sdk.responses.mock.calls[0]![0]).toMatchObject({ reasoning: { effort: 'xhigh' } })
  })

  it('never switches Azure', async () => {
    const fetchMock = vi.fn(async () => refusal())
    vi.stubGlobal('fetch', fetchMock)
    const azure = new AzureOpenAIProvider(cfg({ apiMode: 'azure', baseUrl: undefined, azureResource: 'myres', auth: { type: 'api_key', scheme: 'raw', headerName: 'api-key' } }), 'secret')
    await expect(textOf(azure, ask('gpt-prod'))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sdk.responses).not.toHaveBeenCalled()
  })
})
