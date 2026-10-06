import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './openai/OpenAIProvider'
import { AnthropicProvider } from './anthropic/AnthropicProvider'
import { userMessage } from '../builders'
import type { AIRequest } from '../types/request'
import type { AIStreamEvent } from '../types/stream'
import type { Capability } from '../types/capabilities'
import type { ProviderConfig } from '../types/provider'

type Variant = 'openai-chat' | 'openai-responses' | 'anthropic'

function responseFor(variant: Variant): Response {
  const body = variant === 'openai-chat'
    ? 'data: {"id":"reply","choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    : variant === 'openai-responses'
      ? 'event: response.created\ndata: {"type":"response.created","response":{"id":"reply"}}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"reply","status":"completed"}}\n\n'
      : 'event: message_start\ndata: {"type":"message_start","message":{"id":"reply","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function fixture(variant: Variant, capabilities?: Capability[]) {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return responseFor(variant)
  }))
  const config: ProviderConfig = {
    id: 'native', kind: variant === 'anthropic' ? 'anthropic' : 'openai', name: 'Native provider',
    baseUrl: 'https://example.test/v1', enabled: true, accessType: 'api', auth: { type: 'api_key' },
    ...(variant === 'openai-chat' ? { apiMode: 'chat_completions' } : {}),
    ...(capabilities ? { capabilities } : {})
  }
  const provider = variant === 'anthropic' ? new AnthropicProvider(config, 'fixture-key') : new OpenAIProvider(config, 'fixture-key')
  // This pinned OpenAI SDK uses its own node-fetch transport. Replace only that
  // transport so real SDK serialization and SSE parsing stay under test.
  if (provider instanceof OpenAIProvider) {
    (provider as unknown as { client: { fetch: typeof fetch } }).client.fetch = globalThis.fetch
  }
  return {
    bodies,
    provider,
    unsupported: variant === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o',
    supported: variant === 'anthropic' ? 'claude-opus-4-8' : 'gpt-6-astra'
  }
}

async function collect(events: AsyncIterable<AIStreamEvent>): Promise<void> {
  for await (const _event of events) { /* Drain the real adapter stream. */ }
}

function expectNoEffort(body: Record<string, unknown>): void {
  expect(body).not.toHaveProperty('reasoning_effort')
  expect(body).not.toHaveProperty('reasoning')
  expect(body).not.toHaveProperty('output_config')
  expect(body).not.toHaveProperty('thinking')
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.each(['openai-chat', 'openai-responses', 'anthropic'] as const)('%s provider effort boundary', (variant) => {
  it.each(['streamMessage', 'sendMessage'] as const)('%s removes stale effort for a non-reasoning model', async (method) => {
    const { provider, bodies, unsupported } = fixture(variant)
    const request: AIRequest = { model: unsupported, messages: [userMessage('hi')], params: { reasoningEffort: 'high', maxOutputTokens: 100 } }
    if (method === 'streamMessage') await collect(provider.streamMessage(request))
    else expect((await provider.sendMessage(request)).text).toBe('Hello')
    expect(bodies).toHaveLength(1)
    expectNoEffort(bodies[0]!)
    expect(request.params).toEqual({ reasoningEffort: 'high', maxOutputTokens: 100 })
  })

  it.each(['streamMessage', 'sendMessage'] as const)('%s preserves effort on a supported model', async (method) => {
    const { provider, bodies, supported } = fixture(variant)
    const request: AIRequest = { model: supported, messages: [userMessage('hi')], params: { reasoningEffort: 'high' } }
    if (method === 'streamMessage') await collect(provider.streamMessage(request))
    else expect((await provider.sendMessage(request)).text).toBe('Hello')
    expect(bodies).toHaveLength(1)
    const expected = variant === 'openai-chat' ? { reasoning_effort: 'high' }
      : variant === 'openai-responses' ? { reasoning: { effort: 'high' } }
        : { output_config: { effort: 'high' }, thinking: { type: 'adaptive' } }
    expect(bodies[0]).toMatchObject(expected)
  })

  it.each(['streamMessage', 'sendMessage'] as const)('%s honors declared reasoning opt-out even on a known reasoning model', async (method) => {
    const { provider, bodies, supported } = fixture(variant, ['text', 'streaming'])
    const request: AIRequest = { model: supported, messages: [userMessage('hi')], params: { reasoningEffort: 'max' } }
    if (method === 'streamMessage') await collect(provider.streamMessage(request))
    else await provider.sendMessage(request)
    expect(bodies).toHaveLength(1)
    expectNoEffort(bodies[0]!)
  })
})
