import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from './OpenAICompatProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'
import type { ModelInfo } from '../../types/model'

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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenAICompatProvider toModelInfo reasoning detection', () => {
  it('sets supportsReasoning: true for inferred reasoning models', async () => {
    const inferredModels = [
      'deepseek-ai/deepseek-r1',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'qwen/qwen3-235b-a22b',
      'deepseek-ai/deepseek-v3.1',
      'deepseek-ai/deepseek-v3-thinking',
      'deepseek-ai/deepseek-v4',
      'anthropic/claude-3-7-sonnet',
      'google/gemini-2.5-pro',
      'x-ai/grok-3-mini',
      'step-r1'
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: inferredModels.map((id) => ({ id })) })
      }))
    )

    const provider = new OpenAICompatProvider(cfg())
    const models = await provider.getModels()

    for (const m of models) {
      expect(m.supportsReasoning, `${m.id} should have supportsReasoning: true`).toBe(true)
    }
  })

  it('sets supportsReasoning: false for non-reasoning models when capability is not declared', async () => {
    const nonReasoningModels = [
      'meta/llama-3.1-8b-instruct',
      'mistralai/mistral-7b-instruct-v0.3',
      'deepseek-ai/deepseek-v3',
      'anthropic/claude-3-5-haiku'
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: nonReasoningModels.map((id) => ({ id })) })
      }))
    )

    const provider = new OpenAICompatProvider(cfg())
    const models = await provider.getModels()

    for (const m of models) {
      expect(m.supportsReasoning, `${m.id} should have supportsReasoning: false`).toBe(false)
    }
  })

  it('respects declared reasoning capability even for generic model names', () => {
    const provider = new OpenAICompatProvider(cfg({ capabilities: ['text', 'streaming', 'reasoning'] }))
    const model = (provider as unknown as { toModelInfo: (id: string) => ModelInfo }).toModelInfo('custom-model-id')
    expect(model.supportsReasoning).toBe(true)
  })
})

describe('OpenAICompatProvider <think>...</think> extraction in streamMessage', () => {
  it('extracts <think>...</think> in content delta as reasoning_delta', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<think>Let me calculate the steps carefully.</think>The solution is 42."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))

    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'deepseek-ai/deepseek-r1', messages: [userMessage('solve')] }))

    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text).join('')
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')

    expect(reasoning).toBe('Let me calculate the steps carefully.')
    expect(text).toBe('The solution is 42.')
  })

  it('handles <think> and </think> tags split across multiple small chunks', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ink>"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Step 1: First phase. "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Step 2: Second phase."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"</th"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ink>\\nFinal answer ready."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))

    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'nvidia/llama-3.3-nemotron-super-49b-v1', messages: [userMessage('plan')] }))

    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text).join('')
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')

    expect(reasoning).toBe('Step 1: First phase. Step 2: Second phase.')
    expect(text).toBe('Final answer ready.')
  })

  it('supports delta.thought field alongside reasoning_content and reasoning', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"thought":"Analyzing constraints via thought field."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Here is the verified output."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))

    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')] }))

    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Analyzing constraints via thought field.' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'Here is the verified output.' })
  })

  it('bypasses think tag parsing when native structured reasoning is present', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"Native reasoning block."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"<think>This literal tag should not be parsed as reasoning</think>."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))

    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')] }))

    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text)
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')

    expect(reasoning).toEqual(['Native reasoning block.'])
    expect(text).toBe('<think>This literal tag should not be parsed as reasoning</think>.')
  })

  it('flushes unclosed <think> before stop event', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<think>Unclosed thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))

    const provider = new OpenAICompatProvider(cfg(), 'secret')
    const events = await collect(provider.streamMessage({ model: 'x', messages: [userMessage('hi')] }))

    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text).join('')
    expect(reasoning).toBe('Unclosed thinking')
    expect(events).toContainEqual({ type: 'stop', stopReason: 'length' })
  })
})
