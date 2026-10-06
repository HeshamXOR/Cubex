import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './OpenAIProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { AIRequest } from '../../types/request'
import type { ProviderConfig } from '../../types/provider'

const sdk = vi.hoisted(() => ({ chat: vi.fn(), refusal: undefined as unknown as (status: number, message: string) => Error }))
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  sdk.refusal = (status, message) => new actual.APIError(status, { message }, `${status} ${message}`, {})
  return {
    ...actual,
    default: class {
      responses = { create: vi.fn() }
      chat = { completions: { create: sdk.chat } }
    }
  }
})

function config(baseUrl?: string): ProviderConfig {
  return {
    id: 'openai', kind: 'openai', name: 'OpenAI', accessType: 'api', auth: { type: 'api_key', scheme: 'bearer' },
    enabled: true, apiMode: 'chat_completions', ...(baseUrl ? { baseUrl } : {})
  }
}

const answer = () => (async function* () {
  yield { id: 'r1', choices: [{ delta: { content: 'Done.' } }] }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }
})()

async function run(provider: OpenAIProvider, request: AIRequest): Promise<AIStreamEvent[]> {
  const events: AIStreamEvent[] = []
  for await (const event of provider.streamMessage(request)) events.push(event)
  return events
}

const ask = (model = 'some-model', extra: Partial<AIRequest> = {}): AIRequest => ({ model, messages: [userMessage('hi')], ...extra })
const bodyOf = (call: number): Record<string, any> => sdk.chat.mock.calls[call]![0]

/** A tool loop whose first assistant turn carried reasoning. */
const loop = (model: string): AIRequest => ({
  model,
  messages: [
    userMessage('Fix it'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'read a.ts first' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] }
  ]
})

afterEach(() => vi.resetAllMocks())

describe('OpenAIProvider chat completions extras', () => {
  it('sends stream_options and metadata to OpenAI itself, and never reasoning_content', async () => {
    sdk.chat.mockResolvedValue(answer())
    await run(new OpenAIProvider(config(), 'k'), { ...loop('gpt-5.6'), metadata: { user_id: 'u1' } })
    expect(bodyOf(0).stream_options).toEqual({ include_usage: true })
    expect(bodyOf(0).metadata).toEqual({ user_id: 'u1' })
    expect(JSON.stringify(bodyOf(0))).not.toContain('reasoning_content')
  })

  it('keeps metadata off a custom base URL, which is some other server', async () => {
    sdk.chat.mockResolvedValue(answer())
    await run(new OpenAIProvider(config('https://llm.example.test/v1'), 'k'), ask('m', { metadata: { user_id: 'u1' } }))
    expect(bodyOf(0)).not.toHaveProperty('metadata')
    expect(bodyOf(0).stream_options).toEqual({ include_usage: true })
  })

  it('echoes reasoning_content to DeepSeek', async () => {
    sdk.chat.mockResolvedValue(answer())
    await run(new OpenAIProvider(config('https://api.deepseek.com'), 'k'), loop('deepseek-v4-pro'))
    expect(bodyOf(0).messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'read a.ts first' })
  })

  it('retries once without stream_options when a 400 names it, and usage keeps flowing', async () => {
    sdk.chat.mockRejectedValueOnce(sdk.refusal(400, 'Unrecognized request argument supplied: stream_options')).mockResolvedValueOnce(answer())
    const events = await run(new OpenAIProvider(config('https://llm.example.test/v1'), 'k'), ask())
    expect(sdk.chat).toHaveBeenCalledTimes(2)
    expect(bodyOf(0)).toHaveProperty('stream_options')
    expect(bodyOf(1)).not.toHaveProperty('stream_options')
    expect(bodyOf(1).messages).toEqual(bodyOf(0).messages)
    expect(events.find((event) => event.type === 'usage')).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3 } })
  })

  it('remembers the refusal for the model', async () => {
    sdk.chat.mockRejectedValueOnce(sdk.refusal(400, 'unknown field stream_options')).mockResolvedValue(answer())
    const provider = new OpenAIProvider(config('https://llm.example.test/v1'), 'k')
    await run(provider, ask())
    sdk.chat.mockResolvedValue(answer())
    await run(provider, ask())
    expect(sdk.chat).toHaveBeenCalledTimes(3)
    expect(bodyOf(2)).not.toHaveProperty('stream_options')
  })

  it('retries only once, and not for a 400 about something else', async () => {
    sdk.chat.mockRejectedValue(sdk.refusal(400, 'unknown field stream_options'))
    await expect(run(new OpenAIProvider(config('https://llm.example.test/v1'), 'k'), ask())).rejects.toMatchObject({ statusCode: 400 })
    expect(sdk.chat).toHaveBeenCalledTimes(2)

    sdk.chat.mockReset()
    sdk.chat.mockRejectedValue(sdk.refusal(400, 'max_tokens is too large'))
    await expect(run(new OpenAIProvider(config('https://llm.example.test/v1'), 'k'), ask())).rejects.toMatchObject({ statusCode: 400 })
    expect(sdk.chat).toHaveBeenCalledTimes(1)
  })

  it('does not read DeepSeek asking for reasoning_content as a refusal of it', async () => {
    sdk.chat.mockRejectedValue(sdk.refusal(400, 'The reasoning_content in the thinking mode must be passed back to the API.'))
    await expect(run(new OpenAIProvider(config('https://api.deepseek.com'), 'k'), loop('deepseek-v4-pro'))).rejects.toMatchObject({ statusCode: 400 })
    expect(sdk.chat).toHaveBeenCalledTimes(1)
  })

  it('reads usage a server nests inside the choice, as Kimi does', async () => {
    sdk.chat.mockResolvedValue((async function* () {
      yield { id: 'r1', choices: [{ delta: { content: 'Hi' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }] }
    })())
    const events = await run(new OpenAIProvider(config('https://api.moonshot.ai/v1'), 'k'), ask('kimi-k2.6'))
    expect(events.find((event) => event.type === 'usage')).toMatchObject({ usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } })
  })
})
