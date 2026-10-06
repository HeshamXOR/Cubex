import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from './OpenAICompatProvider'
import { CustomProvider } from '../custom/CustomProvider'
import { StreamAccumulator } from '../../streaming/accumulator'
import { assistantTurn, userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'
import type { AIResponse } from '../../types/response'
import type { ProviderConfig } from '../../types/provider'

function cfg(baseUrl: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'compat', kind: 'openai-compat', name: 'Compat', accessType: 'api', baseUrl, auth: { type: 'api_key', scheme: 'bearer' }, enabled: true, ...overrides }
}

const sse = (...chunks: object[]): Response =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const failure = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), { status, headers: { 'content-type': 'application/json' } })

const ANSWER = (): Response => sse(
  { choices: [{ delta: { content: 'Done.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }
)

/** Stub fetch with a queue of responses; every outgoing JSON body is recorded. */
function server(...responses: Array<Response | (() => Response)>) {
  const bodies: Array<Record<string, any>> = []
  const queue = [...responses]
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    const next = queue.shift()
    return typeof next === 'function' ? next() : next ?? ANSWER()
  }))
  return bodies
}

async function run(provider: { streamMessage: OpenAICompatProvider['streamMessage'] }, request: AIRequest): Promise<AIResponse> {
  const acc = new StreamAccumulator('compat', request.model)
  for await (const event of provider.streamMessage(request)) acc.push(event)
  return acc.finalize()
}

const ask = (model = 'some-model', extra: Partial<AIRequest> = {}): AIRequest => ({ model, messages: [userMessage('hi')], stream: true, ...extra })

afterEach(() => vi.unstubAllGlobals())

describe('stream_options and metadata are conditional', () => {
  it('asks an unfamiliar host for stream usage, and reports it', async () => {
    const bodies = server()
    const res = await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true })
    expect(res.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 })
  })

  it('never sends metadata to a compatible server', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask('m', { metadata: { user_id: 'u1' } }))
    expect(bodies[0]).not.toHaveProperty('metadata')
  })

  it('sends both to OpenAI itself', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://api.openai.com/v1'), 'k'), ask('gpt-5.6', { metadata: { user_id: 'u1' } }))
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true })
    expect(bodies[0]!.metadata).toEqual({ user_id: 'u1' })
  })

  it('does not send stream_options to a host known to reject it', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://api.mistral.ai/v1'), 'k'), ask())
    expect(bodies[0]).not.toHaveProperty('stream_options')
    expect(bodies[0]!.stream).toBe(true)
  })

  it('retries once without stream_options when a 400 names it, and usage keeps flowing', async () => {
    const bodies = server(failure(400, 'Unrecognized request argument supplied: stream_options'))
    const res = await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveProperty('stream_options')
    expect(bodies[1]).not.toHaveProperty('stream_options')
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages)
    expect(res.usage).toMatchObject({ inputTokens: 12 })
  })

  it('reads a 422 from a pydantic-validated server the same way', async () => {
    const body = '{"detail":[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]}'
    const bodies = server(new Response(body, { status: 422 }))
    const res = await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toHaveProperty('stream_options')
  })

  it('remembers the refusal, so later requests to that model skip the failed attempt', async () => {
    const bodies = server(failure(400, 'Unrecognized request argument supplied: stream_options'))
    const provider = new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k')
    await run(provider, ask())
    await run(provider, ask())
    expect(bodies).toHaveLength(3)
    expect(bodies[2]).not.toHaveProperty('stream_options')
  })

  it('retries only once', async () => {
    const bodies = server(failure(400, 'unknown field stream_options'), failure(400, 'unknown field stream_options'))
    await expect(run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(2)
  })

  it('does not retry a 400 that is about something else', async () => {
    const bodies = server(failure(400, 'max_tokens is too large for this model'))
    await expect(run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(1)
  })

  it('does not retry other statuses', async () => {
    const bodies = server(failure(500, 'Unrecognized request argument supplied: stream_options'))
    await expect(run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), ask())).rejects.toBeTruthy()
    expect(bodies).toHaveLength(1)
  })

  it('reads usage a server nests inside the choice, as Kimi does', async () => {
    server(sse(
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }] }
    ))
    const res = await run(new OpenAICompatProvider(cfg('https://api.moonshot.ai/v1'), 'k'), ask('kimi-k2.6'))
    expect(res.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 })
  })
})

/** What a thinking-mode server streams for a turn that reads a file: reasoning, then a tool call. */
const thinkingToolTurn = (): Response => sse(
  { choices: [{ delta: { reasoning_content: 'I should ' } }] },
  { choices: [{ delta: { reasoning_content: 'read a.ts first.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 } }
)

/** The agent loop's next request: the assistant turn exactly as produced, then its tool result. */
function continuation(first: AIResponse, model: string): AIRequest {
  return {
    model,
    stream: true,
    messages: [
      userMessage('Fix it'),
      assistantTurn(first),
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'file contents' }] }] }
    ]
  }
}

describe.each([
  ['DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-pro'],
  ['Moonshot (Kimi)', 'https://api.moonshot.ai/v1', 'kimi-k2.6'],
  ['a gateway fronting Kimi', 'https://gateway.example.test/v1', 'moonshotai/Kimi-K2-Thinking']
])('thinking-mode tool loop on %s', (_name, baseUrl, model) => {
  it('captures reasoning_content and echoes it back on the assistant tool turn', async () => {
    const bodies = server(thinkingToolTurn)
    const provider = new OpenAICompatProvider(cfg(baseUrl), 'k')
    const first = await run(provider, { model, messages: [userMessage('Fix it')], stream: true })
    expect(first.content.map((part) => part.type)).toEqual(['reasoning', 'tool_use'])
    expect(first.content[0]).toEqual({ type: 'reasoning', text: 'I should read a.ts first.' })

    await run(provider, continuation(first, model))
    const assistant = bodies[1]!.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.reasoning_content).toBe('I should read a.ts first.')
    expect(assistant.tool_calls).toHaveLength(1)
  })

  it('sends an empty reasoning_content on a tool turn that has none', async () => {
    const bodies = server()
    const provider = new OpenAICompatProvider(cfg(baseUrl), 'k')
    await run(provider, {
      model, stream: true,
      messages: [
        userMessage('Fix it'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] }
      ]
    })
    expect(bodies[0]!.messages[1]).toHaveProperty('reasoning_content', '')
  })

  it('does not treat the server asking for reasoning_content as a refusal of it', async () => {
    const bodies = server(failure(400, 'thinking is enabled but reasoning_content is missing in assistant tool call message at index 3'))
    const provider = new OpenAICompatProvider(cfg(baseUrl), 'k')
    await expect(run(provider, continuation({ ...emptyResponse(), content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] }, model)))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(1)
  })
})

function emptyResponse(): AIResponse {
  return { id: 'r', provider: 'compat', model: 'm', createdAt: 0, text: '', content: [], toolCalls: [], stopReason: 'tool_use' }
}

describe('reasoning_content is not sent where it is not wanted', () => {
  const history = (model: string): AIRequest => ({
    model, stream: true,
    messages: [
      userMessage('Fix it'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'private plan' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] }
    ]
  })

  it('leaves it out for OpenAI itself, even for a DeepSeek-looking model id', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://api.openai.com/v1'), 'k'), history('deepseek-v4-pro'))
    expect(JSON.stringify(bodies[0])).not.toContain('reasoning_content')
  })

  it('leaves it out for an unrelated model on an unknown host', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), history('llama-3.3-70b'))
    expect(JSON.stringify(bodies[0])).not.toContain('reasoning_content')
    expect(JSON.stringify(bodies[0])).not.toContain('private plan')
  })

  it('retries once without it when a server that was guessed to want it refuses it, and remembers', async () => {
    const bodies = server(failure(400, "messages.1: property 'reasoning_content' is unsupported"))
    const provider = new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k')
    const res = await run(provider, history('kimi-k2.6'))
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.messages[1]).toHaveProperty('reasoning_content', 'private plan')
    expect(JSON.stringify(bodies[1])).not.toContain('reasoning_content')
    await run(provider, history('kimi-k2.6'))
    expect(bodies).toHaveLength(3)
    expect(JSON.stringify(bodies[2])).not.toContain('reasoning_content')
  })
})

describe('Custom provider with the openai shape', () => {
  it('follows the same rules as the compatible adapter it delegates to', async () => {
    const bodies = server()
    const provider = new CustomProvider(cfg('https://api.deepseek.com', { kind: 'custom', mapping: { shape: 'openai' } }), 'k')
    await run(provider, {
      model: 'deepseek-v4-pro', stream: true, metadata: { user_id: 'u1' },
      messages: [
        userMessage('Fix it'),
        { role: 'assistant', content: [{ type: 'reasoning', text: 'plan' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] }
      ]
    })
    expect(bodies[0]!.messages[1].reasoning_content).toBe('plan')
    expect(bodies[0]).not.toHaveProperty('metadata')
  })
})

describe('effort levels the app knows for a model', () => {
  // Kimi K3 takes low, high or max and rejects the rest. Its host lists nothing, so the app says what it knows.
  const k3 = 'moonshotai/kimi-k3'
  const known = (efforts: Array<'low' | 'medium' | 'high' | 'max'>) => () => ({ id: k3, supportsReasoning: true, reasoningEfforts: efforts })

  it('sends max when the model is known to take it', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://integrate.api.nvidia.com/v1'), 'k', 'openai-compat', known(['low', 'high', 'max'])), ask(k3, { params: { reasoningEffort: 'max' } }))
    expect(bodies[0]!.reasoning_effort).toBe('max')
  })

  it('moves a level the model does not take to the nearest one it does', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://integrate.api.nvidia.com/v1'), 'k', 'openai-compat', known(['low', 'high', 'max'])), ask(k3, { params: { reasoningEffort: 'medium' } }))
    expect(bodies[0]!.reasoning_effort).toBe('low')
  })

  it('sends no effort to a model that reasons but takes none', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://integrate.api.nvidia.com/v1'), 'k', 'openai-compat', known([])), ask(k3, { params: { reasoningEffort: 'high' } }))
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('falls back to the id when nothing is known, keeping to the levels every host takes', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://integrate.api.nvidia.com/v1'), 'k'), ask(k3, { params: { reasoningEffort: 'max' } }))
    expect(bodies[0]!.reasoning_effort).toBe('high')
  })
})

describe('reasoning_effort is offered on a guess, so a refusal has to be survivable', () => {
  const effortAsk = (model = 'deepseek-ai/deepseek-r1'): AIRequest => ask(model, { params: { reasoningEffort: 'high' } })

  it('sends the chosen effort to a host that has not said whether it reasons', async () => {
    const bodies = server()
    await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), effortAsk())
    expect(bodies[0]!.reasoning_effort).toBe('high')
  })

  it('asks again without it when a 400 names it, and keeps everything else in the request', async () => {
    const bodies = server(failure(400, "Unsupported parameter: 'reasoning_effort'"))
    const res = await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), effortAsk())
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages)
    expect(bodies[1]!.stream_options).toEqual({ include_usage: true })
  })

  it('reads a pydantic 422 the same way', async () => {
    const body = '{"detail":[{"type":"extra_forbidden","loc":["body","reasoning_effort"],"msg":"Extra inputs are not permitted"}]}'
    const bodies = server(new Response(body, { status: 422 }))
    const res = await run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), effortAsk())
    expect(res.text).toBe('Done.')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('remembers the refusal for that model only', async () => {
    const bodies = server(failure(400, "Unsupported parameter: 'reasoning_effort'"))
    const provider = new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k')
    await run(provider, effortAsk('deepseek-ai/deepseek-r1'))
    await run(provider, effortAsk('deepseek-ai/deepseek-r1'))
    await run(provider, effortAsk('qwen/qwq-32b'))
    expect(bodies).toHaveLength(4)
    expect(bodies[2]).not.toHaveProperty('reasoning_effort')
    expect(bodies[3]).toHaveProperty('reasoning_effort', 'high')
  })

  it('does not retry a 400 that is about something else', async () => {
    const bodies = server(failure(400, 'max_tokens is too large for this model'))
    await expect(run(new OpenAICompatProvider(cfg('https://llm.example.test/v1'), 'k'), effortAsk())).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(1)
  })
})
