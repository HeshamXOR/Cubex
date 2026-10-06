import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from './AnthropicProvider'
import { StreamAccumulator } from '../../streaming/accumulator'
import { userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'
import type { AIResponse } from '../../types/response'
import type { ProviderConfig } from '../../types/provider'

/** Serialize recorded Anthropic stream events as an SSE body. */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

const start = {
  type: 'message_start',
  message: { id: 'msg_01Interleaved', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, usage: { input_tokens: 25, output_tokens: 1 } }
}
const thinkingBlock = (index: number, text: string, signature: string): Array<Record<string, unknown>> => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index }
]
const toolBlock = (index: number, id: string, input: string): Array<Record<string, unknown>> => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'read_file', input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } },
  { type: 'content_block_stop', index }
]
const finish = [
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 77 } },
  { type: 'message_stop' }
]

/** A recorded [thinking, tool_use, thinking, tool_use] assistant message. */
const INTERLEAVED = sse([
  start,
  ...thinkingBlock(0, 'I should read a.ts first.', 'sigAAAA=='),
  ...toolBlock(1, 'toolu_01A', '{"path": "a.ts"}'),
  ...thinkingBlock(2, 'Then b.ts, to compare.', 'sigBBBB=='),
  ...toolBlock(3, 'toolu_01B', '{"path": "b.ts"}'),
  ...finish
])

/** [redacted_thinking, thinking, tool_use]: the safety system encrypted the first block. */
const WITH_REDACTED = sse([
  start,
  { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD' } },
  { type: 'content_block_stop', index: 0 },
  ...thinkingBlock(1, 'Visible reasoning.', 'sigCCCC=='),
  ...toolBlock(2, 'toolu_01C', '{"path": "c.ts"}'),
  ...finish
])

const config: ProviderConfig = {
  id: 'anthropic-test', kind: 'anthropic', name: 'Anthropic test',
  baseUrl: 'https://example.test', enabled: true, accessType: 'api', auth: { type: 'api_key' }
}

function fixture(body: string) {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }))
  return { bodies, provider: new AnthropicProvider(config, 'fixture-key') }
}

async function run(provider: AnthropicProvider, request: AIRequest): Promise<AIResponse> {
  const acc = new StreamAccumulator(provider.id, request.model)
  for await (const event of provider.streamMessage(request)) acc.push(event)
  return acc.finalize()
}

const ask: AIRequest = {
  model: 'claude-opus-5',
  messages: [userMessage('Compare a.ts and b.ts')],
  params: { reasoningEffort: 'high' }
}

/** What the agent loop sends next: the assistant turn verbatim, then its tool results. */
function continuation(response: AIResponse): AIRequest {
  return {
    ...ask,
    messages: [
      ...ask.messages,
      { role: 'assistant', content: response.content },
      {
        role: 'tool',
        content: response.toolCalls.map((c) => ({
          type: 'tool_result' as const, toolUseId: c.id, content: [{ type: 'text' as const, text: `contents of ${c.id}` }]
        }))
      }
    ]
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('interleaved thinking through the Anthropic adapter', () => {
  it('records content blocks in stream order', async () => {
    const { provider } = fixture(INTERLEAVED)
    const res = await run(provider, ask)
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'tool_use', 'reasoning', 'tool_use'])
    expect(res.stopReason).toBe('tool_use')
    expect(res.toolCalls.map((c) => c.id)).toEqual(['toolu_01A', 'toolu_01B'])
  })

  it('replays the assistant turn verbatim, signatures included, in the same order', async () => {
    const first = fixture(INTERLEAVED)
    const res = await run(first.provider, ask)
    vi.unstubAllGlobals()

    const second = fixture(INTERLEAVED)
    await run(second.provider, continuation(res))
    const messages = second.bodies[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([
      { type: 'thinking', thinking: 'I should read a.ts first.', signature: 'sigAAAA==' },
      { type: 'tool_use', id: 'toolu_01A', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'thinking', thinking: 'Then b.ts, to compare.', signature: 'sigBBBB==' },
      { type: 'tool_use', id: 'toolu_01B', name: 'read_file', input: { path: 'b.ts' } }
    ])
    expect(messages[2]!.content.map((b) => b.tool_use_id)).toEqual(['toolu_01A', 'toolu_01B'])
  })

  it('keeps redacted_thinking in place and unmodified', async () => {
    const first = fixture(WITH_REDACTED)
    const res = await run(first.provider, ask)
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'reasoning', 'tool_use'])
    expect(res.content[0]).toMatchObject({ redacted: 'ENCRYPTED-PAYLOAD' })
    vi.unstubAllGlobals()

    const second = fixture(WITH_REDACTED)
    await run(second.provider, continuation(res))
    const messages = second.bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[1]!.content).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD' },
      { type: 'thinking', thinking: 'Visible reasoning.', signature: 'sigCCCC==' },
      { type: 'tool_use', id: 'toolu_01C', name: 'read_file', input: { path: 'c.ts' } }
    ])
  })

  it('replays a thinking block whose text was omitted, keeping its signature', async () => {
    const omitted = sse([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigOMIT==' } },
      { type: 'content_block_stop', index: 0 },
      ...toolBlock(1, 'toolu_01D', '{"path": "d.ts"}'),
      ...finish
    ])
    const first = fixture(omitted)
    const res = await run(first.provider, ask)
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'tool_use'])
    vi.unstubAllGlobals()

    const second = fixture(omitted)
    await run(second.provider, continuation(res))
    const messages = second.bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[1]!.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sigOMIT==' })
  })
})
