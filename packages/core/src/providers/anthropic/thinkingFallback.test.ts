import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from './AnthropicProvider'
import { StreamAccumulator } from '../../streaming/accumulator'
import { userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'
import type { AIResponse } from '../../types/response'
import type { ProviderConfig } from '../../types/provider'

const config: ProviderConfig = {
  id: 'anthropic-test', kind: 'anthropic', name: 'Anthropic test',
  baseUrl: 'https://example.test', enabled: true, accessType: 'api', auth: { type: 'api_key' }
}

const OK = [
  { type: 'message_start', message: { id: 'msg_ok', usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

const stream = (): Response => new Response(OK, { headers: { 'content-type': 'text/event-stream' } })
const rejection = (message: string): Response => new Response(
  JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  { status: 400, headers: { 'content-type': 'application/json' } }
)

/** The 400s Anthropic documents for thinking-related history problems. */
const MUST_START_WITH_THINKING =
  'messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, ' +
  'a final `assistant` message must start with a thinking block (preceeding the lastmost set of `tool_use` and `tool_result` blocks). ' +
  'We recommend you include thinking blocks from previous turns. To avoid this requirement, disable `thinking`.'
const BOUND_TO_OTHER_CONVERSATION =
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. ' +
  'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".'
const MODIFIED =
  'messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. ' +
  'These blocks must remain as they were in the original response.'

function fixture(...responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = []
  const queue = [...responses]
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return queue.shift() ?? stream()
  }))
  return { bodies, provider: new AnthropicProvider(config, 'fixture-key') }
}

async function run(provider: AnthropicProvider, request: AIRequest): Promise<AIResponse> {
  const acc = new StreamAccumulator(provider.id, request.model)
  for await (const event of provider.streamMessage(request)) acc.push(event)
  return acc.finalize()
}

const toolResult = { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_1', content: [{ type: 'text' as const, text: 'ok' }] }] }

/** A tool loop whose first assistant turn came from another provider: no signed thinking. */
const foreignHistory: AIRequest = {
  model: 'claude-opus-5',
  messages: [
    userMessage('Fix it'),
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'foreign summary' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
    ] },
    toolResult
  ],
  params: { reasoningEffort: 'high' }
}

/** The same loop after Anthropic produced the first turn, with signed thinking. */
const signedHistory: AIRequest = {
  ...foreignHistory,
  messages: [
    userMessage('Fix it'),
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'plan', signature: 'sigA==' },
      { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
    ] },
    toolResult
  ]
}

const thinkingBlocks = (body: Record<string, unknown>): number =>
  (body.messages as Array<{ content: Array<{ type: string }> }>)
    .flatMap((m) => m.content).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length

afterEach(() => vi.unstubAllGlobals())

describe('Anthropic requests whose history cannot satisfy thinking', () => {
  it('sends history from another provider without thinking blocks or foreign reasoning', async () => {
    const { bodies, provider } = fixture()
    await run(provider, foreignHistory)
    expect(thinkingBlocks(bodies[0]!)).toBe(0)
    const assistant = (bodies[0]!.messages as Array<{ role: string; content: Array<{ type: string }> }>)[1]!
    expect(assistant.content.map((b) => b.type)).toEqual(['tool_use'])
    expect(bodies[0]!.thinking).toMatchObject({ type: 'adaptive' })
  })

  it('retries once without thinking when the API demands a leading thinking block', async () => {
    const { bodies, provider } = fixture(rejection(MUST_START_WITH_THINKING))
    const res = await run(provider, foreignHistory)
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.thinking).toBeDefined()
    expect(bodies[1]).not.toHaveProperty('thinking')
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages)
  })

  it('retries once with every thinking block stripped when a signature does not verify here', async () => {
    const { bodies, provider } = fixture(rejection(BOUND_TO_OTHER_CONVERSATION))
    const res = await run(provider, signedHistory)
    expect(res.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    expect(thinkingBlocks(bodies[0]!)).toBe(2)
    expect(thinkingBlocks(bodies[1]!)).toBe(0)
    expect(bodies[1]).not.toHaveProperty('thinking')
    // Everything else in the turn stays where it was.
    const assistant = (bodies[1]!.messages as Array<{ role: string; content: Array<{ type: string }> }>)[1]!
    expect(assistant.content.map((b) => b.type)).toEqual(['tool_use'])
    expect((bodies[1]!.messages as unknown[]).length).toBe(3)
  })

  it('retries when the API says the latest assistant thinking was modified', async () => {
    const { bodies, provider } = fixture(rejection(MODIFIED))
    await run(provider, signedHistory)
    expect(bodies).toHaveLength(2)
    expect(thinkingBlocks(bodies[1]!)).toBe(0)
  })

  it('retries only once', async () => {
    const { bodies, provider } = fixture(rejection(BOUND_TO_OTHER_CONVERSATION), rejection(BOUND_TO_OTHER_CONVERSATION))
    await expect(run(provider, signedHistory)).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(2)
  })

  it('does not retry unrelated 400s', async () => {
    const { bodies, provider } = fixture(rejection('max_tokens: 999999 > 128000, which is the maximum allowed number of output tokens'))
    await expect(run(provider, signedHistory)).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(1)
  })

  it('does not retry when the request carried no thinking to remove', async () => {
    const { bodies, provider } = fixture(rejection(MUST_START_WITH_THINKING))
    const { params: _params, ...plain } = foreignHistory
    await expect(run(provider, plain)).rejects.toMatchObject({ statusCode: 400 })
    expect(bodies).toHaveLength(1)
  })
})
