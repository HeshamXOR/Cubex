import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from './OpenAICompatProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'compat',
    kind: 'openai-compat',
    name: 'Compat',
    accessType: 'api',
    baseUrl: 'https://example.test/v1',
    auth: { type: 'api_key', scheme: 'bearer' },
    enabled: true,
    ...overrides
  }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i++
    }
  })
  return { ok: true, status: 200, body, headers: new Headers() } as unknown as Response
}

async function collect(gen: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const out: AIStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

afterEach(() => vi.restoreAllMocks())

describe('OpenAICompatProvider streaming', () => {
  it('parses SSE deltas into normalized text_delta + usage events', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')], stream: true }))
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('Hello')
    expect(events.some((e) => e.type === 'usage')).toBe(true)
  })

  it('normalizes a 429 into a retryable rate-limit error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '2' }),
        json: async () => ({ error: { message: 'slow down' } }),
        text: async () => '{"error":{"message":"slow down"}}'
      })) as unknown as typeof fetch
    )
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    await expect(
      collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')], stream: true }))
    ).rejects.toMatchObject({ category: 'RATE_LIMIT_ERROR', retryable: true })
  })
})

describe('OpenAICompatProvider capability gating', () => {
  it('rejects image input when the model lacks vision capability', async () => {
    const provider = new OpenAICompatProvider(cfg({ capabilities: ['text', 'streaming'] }), 'secret')
    await expect(
      collect(
        provider.streamMessage({
          model: 'x',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } }]
            }
          ]
        })
      )
    ).rejects.toMatchObject({ category: 'INVALID_REQUEST', message: 'This model does not support image input.' })
  })
})
