import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from './OpenAICompatProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import { AIGateway } from '../../gateway/AIGateway'
import { DEFAULT_RETRY_POLICY } from '../../types/retry'

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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  it.each(['reasoning_content', 'reasoning'])('forwards %s while the provider is still preparing tool arguments', async (field) => {
    const encoder = new TextEncoder()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events: AIStreamEvent[] = []
    const pending = (async () => {
      for await (const event of provider.streamMessage({ model: 'reasoning-model', messages: [userMessage('Make a plan')] })) events.push(event)
    })()
    try {
      source.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { [field]: 'Checking the plan constraints.' } }] })}\n\n`))
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Checking the plan constraints.' }))
      expect(events.some((event) => event.type === 'text_delta' || event.type === 'stop')).toBe(false)
      source.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"plan-1","function":{"name":"exit_plan_mode","arguments":"{\\\"plan\\\":"}}]}}]}\n\n'))
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'tool_call_delta', index: 0, id: 'plan-1', name: 'exit_plan_mode', argsDelta: '{"plan":' }))
    } finally {
      source.enqueue(encoder.encode('data: [DONE]\n\n'))
      source.close()
      await pending
    }
  })

  it('does not duplicate reasoning aliases or render non-text reasoning payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"One summary.","reasoning":"One summary.","content":"The answer."}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":{"encrypted":"private-payload"}}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":{"encrypted":"private-payload"},"reasoning":"Another summary."}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"","reasoning":""}}]}\n\n',
      'data: [DONE]\n\n'
    ])))
    const provider = new OpenAICompatProvider(cfg())
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')] }))
    expect(events).toEqual([
      { type: 'start', provider: 'compat', model: 'x' },
      { type: 'reasoning_delta', text: 'One summary.' },
      { type: 'text_delta', text: 'The answer.' },
      { type: 'reasoning_delta', text: 'Another summary.' }
    ])
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

describe.each(['openai-compat', 'lmstudio', 'llamacpp'] as const)('%s effort at the request boundary', (kind) => {
  it.each(['streamMessage', 'sendMessage'] as const)('%s strips inherited effort without declared support', async (method) => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sseResponse(['data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
    }))
    const provider = new OpenAICompatProvider(cfg({ kind }), 'secret', kind)
    const request: AIRequest = { model: 'gpt-6-astra', messages: [userMessage('hi')], params: { reasoningEffort: 'high', maxOutputTokens: 200 } }
    if (method === 'streamMessage') await collect(provider.streamMessage(request))
    else expect((await provider.sendMessage(request)).text).toBe('Hello')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[0]).toMatchObject({ max_tokens: 200 })
    expect(request.params?.reasoningEffort).toBe('high')
  })

  it.each(['streamMessage', 'sendMessage'] as const)('%s preserves effort when the endpoint declares reasoning', async (method) => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sseResponse(['data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
    }))
    const provider = new OpenAICompatProvider(cfg({ kind, capabilities: ['text', 'streaming', 'reasoning'] }), 'secret', kind)
    const request: AIRequest = { model: 'fixture-model', messages: [userMessage('hi')], params: { reasoningEffort: 'medium' } }
    if (method === 'streamMessage') await collect(provider.streamMessage(request))
    else expect((await provider.sendMessage(request)).text).toBe('Hello')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'medium' })
  })
})

describe('fallback effort sanitization', () => {
  it.each(['stream', 'send'] as const)('clears primary effort when gateway.%s falls back to an unsupported endpoint', async (method) => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      bodies.push(body)
      if (body.model === 'reasoning-model') return new Response('{"error":{"message":"Primary unavailable"}}', { status: 503 })
      return sseResponse(['data: {"choices":[{"delta":{"content":"Backup result"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
    }))
    const primary = new OpenAICompatProvider(cfg({ id: 'primary', capabilities: ['text', 'streaming', 'reasoning'] }))
    const backup = new OpenAICompatProvider(cfg({ id: 'backup' }))
    const gateway = new AIGateway((id) => id === 'primary' ? primary : backup)
    const request: AIRequest = { model: 'reasoning-model', messages: [userMessage('hi')], params: { reasoningEffort: 'high' } }
    const policy = { primary: { providerId: 'primary', model: 'reasoning-model' }, fallbacks: [{ providerId: 'backup', model: 'fixture-model' }],
      fallbackEnabled: true, retry: { ...DEFAULT_RETRY_POLICY, enabled: false, maxAttempts: 1 }, timeout: {} }
    if (method === 'stream') await collect(gateway.stream(request, policy))
    else expect((await gateway.send(request, policy)).text).toBe('Backup result')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high', model: 'reasoning-model' })
    expect(bodies[1]).toMatchObject({ model: 'fixture-model' })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    expect(request.params?.reasoningEffort).toBe('high')
  })
})

describe('OpenAICompatProvider stream failure modes', () => {
  it('turns an in-band error frame after HTTP 200 into an error, not a finished answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"code":503,"message":"upstream overloaded"},"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'
    ])))
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    await expect(collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')], stream: true }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('keeps parallel tool calls apart when the server omits delta indexes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    ])))
    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')], stream: true }))
    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Array<{ index: number; id?: string }>
    expect(deltas.map((d) => d.index)).toEqual([0, 0, 1])
  })
})
