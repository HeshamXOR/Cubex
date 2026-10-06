import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from './AnthropicProvider'
import { StreamAccumulator } from '../../streaming/accumulator'
import { userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'
import type { ProviderConfig } from '../../types/provider'

const config: ProviderConfig = {
  id: 'anthropic-test', kind: 'anthropic', name: 'Anthropic test',
  baseUrl: 'https://example.test', enabled: true, accessType: 'api', auth: { type: 'api_key' }
}

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const sse = (events: Array<{ type: string } & Record<string, unknown>>): Response =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

function modelsEndpoint(data: unknown[]): AnthropicProvider {
  vi.stubGlobal('fetch', vi.fn(async () => json({ data, has_more: false, first_id: null, last_id: null })))
  return new AnthropicProvider(config, 'key')
}

describe('the models an Anthropic-style endpoint lists', () => {
  it('takes the window and the reply limit the endpoint reports', async () => {
    const models = await modelsEndpoint([
      { id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 64_000, capabilities: null }
    ]).getModels()
    expect(models[0]).toMatchObject({ id: 'claude-sonnet-5-5', contextWindow: 200_000, maxOutputTokens: 64_000, supportsReasoning: true })
  })

  it('describes a model it has never seen by its family, and says nothing about a limit it does not know', async () => {
    const models = await modelsEndpoint([
      { id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' },
      { id: 'claude-mystery-1', type: 'model', display_name: 'Mystery', created_at: '2026-01-01T00:00:00Z' }
    ]).getModels()
    const byId = Object.fromEntries(models.map((model) => [model.id, model]))
    // The family settles reasoning and how much it can write; the window stays the standard 200K until the endpoint says otherwise.
    expect(byId['claude-sonnet-5-5']).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 128_000, supportsReasoning: true })
    expect(byId['claude-mystery-1']).toMatchObject({ contextWindow: 200_000, supportsReasoning: false })
    expect(byId['claude-mystery-1']).not.toHaveProperty('maxOutputTokens')
  })

  it('believes the endpoint over the family when it reports capabilities', async () => {
    const models = await modelsEndpoint([
      { id: 'claude-sonnet-5-5', type: 'model', display_name: 'S', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 8_192, capabilities: { thinking: { supported: false } } }
    ]).getModels()
    expect(models[0]).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 8_192, supportsReasoning: false })
  })
})

describe('a reply cut off by the output limit', () => {
  const request: AIRequest = {
    model: 'claude-sonnet-5-5',
    messages: [userMessage('Write the page.')],
    tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
    params: { maxOutputTokens: 4096 }
  }

  it('reaches the caller as a length stop with the unfinished call marked unparsed', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sse([
        { type: 'message_start', message: { id: 'msg_cut', usage: { input_tokens: 14_000, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing it now.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"page.html","content":"<html><body>' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
        { type: 'message_stop' }
      ])
    }))
    const provider = new AnthropicProvider(config, 'key')
    const accumulator = new StreamAccumulator(provider.id, request.model)
    for await (const event of provider.streamMessage(request)) accumulator.push(event)
    const response = accumulator.finalize()
    expect(bodies[0]).toMatchObject({ max_tokens: 4096, tools: [{ name: 'write_file' }] })
    expect(response.stopReason).toBe('length')
    expect(response.usage?.outputTokens).toBe(4096)
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0]?.input).toEqual({ _raw: '{"path":"page.html","content":"<html><body>' })
  })
})

describe('the long-context beta header', () => {
  it('is sent for any model the caller opted in for, not only one on a built-in list', async () => {
    const headers: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(Object.fromEntries(new Headers(init.headers).entries()))
      return sse([{ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'message_stop' }])
    }))
    const provider = new AnthropicProvider(config, 'key')
    const run = async (opts?: { headers: Record<string, string> }): Promise<void> => {
      for await (const event of provider.streamMessage({ model: 'claude-sonnet-5-5', messages: [userMessage('hi')] }, opts)) void event
    }
    await run({ headers: { 'x-cubex-long-context': '1' } })
    await run()
    expect(headers[0]?.['anthropic-beta']).toBe('context-1m-2025-08-07')
    expect(headers[0]).not.toHaveProperty('x-cubex-long-context')
    expect(headers[1]).not.toHaveProperty('anthropic-beta')
  })
})
