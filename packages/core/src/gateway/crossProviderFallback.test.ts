import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIGateway } from './AIGateway'
import { AnthropicProvider } from '../providers/anthropic/AnthropicProvider'
import { OpenAICompatProvider } from '../providers/openai-compat/OpenAICompatProvider'
import { userMessage } from '../builders'
import { DEFAULT_RETRY_POLICY } from '../types/retry'
import type { AIProvider, ProviderConfig } from '../types/provider'
import type { AIRequest } from '../types/request'
import type { GatewayEvent, RoutingPolicy } from '../types/routing'

/**
 * A turn that falls back from one provider to another in the middle of a tool
 * loop: the history was written by the first provider, and carries its
 * reasoning in a form the second cannot use.
 */

const config = (id: string, kind: ProviderConfig['kind'], baseUrl: string): ProviderConfig =>
  ({ id, kind, name: id, baseUrl, enabled: true, accessType: 'api', auth: { type: 'api_key' } })

const outage = (): Response => new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })

const anthropicAnswer = (): Response => new Response([
  { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

const chatAnswer = (): Response => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } })}\n\n` +
  'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } }
)

const toolResult = { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_1', content: [{ type: 'text' as const, text: 'file contents' }] }] }
const call = { type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }

const policy = (primary: string, fallback: string, fallbackModel: string): RoutingPolicy => ({
  primary: { providerId: primary, model: 'primary-model' },
  fallbacks: [{ providerId: fallback, model: fallbackModel }],
  fallbackEnabled: true,
  retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
  timeout: {}
})

/** Route fetches by host: the primary is down, the fallback answers. */
function network(answers: Record<string, () => Response>) {
  const sent: Array<{ host: string; body: Record<string, any> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const host = new URL(url).host
    sent.push({ host, body: JSON.parse(init.body as string) })
    return answers[host]!()
  }))
  return sent
}

afterEach(() => vi.unstubAllGlobals())

describe('falling back mid tool loop', () => {
  it('OpenAI-style primary to Anthropic with effort on: foreign reasoning is dropped, thinking stays on', async () => {
    const sent = network({ 'primary.test': outage, 'backup.test': anthropicAnswer })
    const providers: Record<string, AIProvider> = {
      primary: new OpenAICompatProvider(config('primary', 'openai-compat', 'https://primary.test/v1'), 'k'),
      backup: new AnthropicProvider(config('backup', 'anthropic', 'https://backup.test'), 'k')
    }
    const request: AIRequest = {
      model: 'primary-model',
      messages: [
        userMessage('Fix it'),
        { role: 'assistant', content: [{ type: 'reasoning', text: 'a summary the first provider wrote' }, call] },
        toolResult
      ],
      params: { reasoningEffort: 'high' }
    }
    const events: GatewayEvent[] = []
    const res = await new AIGateway((id) => providers[id]).send(request, policy('primary', 'backup', 'claude-opus-5'), { onEvent: (e) => events.push(e) })

    expect(res.text).toBe('Done.')
    expect(res.provider).toBe('backup')
    expect(events.some((e) => e.type === 'fallback')).toBe(true)
    const body = sent.find((s) => s.host === 'backup.test')!.body
    expect(body.thinking).toMatchObject({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.messages[1].content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }])
    expect(JSON.stringify(body)).not.toContain('a summary the first provider wrote')
  })

  it('Anthropic primary to DeepSeek: signed thinking stays behind, the tool turn still carries reasoning_content', async () => {
    const sent = network({ 'primary.test': outage, 'api.deepseek.com': chatAnswer })
    const providers: Record<string, AIProvider> = {
      primary: new AnthropicProvider(config('primary', 'anthropic', 'https://primary.test'), 'k'),
      backup: new OpenAICompatProvider(config('backup', 'openai-compat', 'https://api.deepseek.com'), 'k')
    }
    const request: AIRequest = {
      model: 'primary-model',
      messages: [
        userMessage('Fix it'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'summary of signed thinking', signature: 'sigAAAA==' },
            { type: 'reasoning', text: '', redacted: 'ENCRYPTED-PAYLOAD' },
            call
          ]
        },
        toolResult
      ],
      params: { reasoningEffort: 'high' }
    }
    const res = await new AIGateway((id) => providers[id]).send(request, policy('primary', 'backup', 'deepseek-v4-pro'))

    expect(res.text).toBe('Done.')
    expect(res.usage).toMatchObject({ inputTokens: 9, outputTokens: 2 })
    const body = sent.find((s) => s.host === 'api.deepseek.com')!.body
    expect(body.messages[1]).toMatchObject({ role: 'assistant', reasoning_content: '', tool_calls: [{ id: 'call_1' }] })
    expect(JSON.stringify(body)).not.toContain('signed thinking')
    expect(JSON.stringify(body)).not.toContain('sigAAAA')
    expect(JSON.stringify(body)).not.toContain('ENCRYPTED-PAYLOAD')
  })
})
