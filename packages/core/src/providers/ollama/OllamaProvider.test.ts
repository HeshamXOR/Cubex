import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from './OllamaProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'

function cfg(): ProviderConfig {
  return {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama',
    accessType: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    auth: { type: 'none' },
    enabled: true
  }
}

function ndjson(lines: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(lines[i]! + '\n'))
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

describe('OllamaProvider streaming (NDJSON)', () => {
  it('parses newline-delimited JSON into text_delta + usage from eval counts', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: ' world' }, done: false }),
      JSON.stringify({
        message: { role: 'assistant', content: '' },
        done: true,
        prompt_eval_count: 5,
        eval_count: 2
      })
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ndjson(lines)))
    const provider = new OllamaProvider(cfg())
    const events = await collect(provider.streamMessage({ model: 'llama3.1:8b', messages: [userMessage('hi')], stream: true }))
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('Hello world')
    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toBeTruthy()
  })

  it('lists installed models from /api/tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: 'mistral:7b', size: 4_400_000_000, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } }]
      })
    })) as unknown as typeof fetch)
    const provider = new OllamaProvider(cfg())
    const models = await provider.getModels()
    expect(models[0]).toMatchObject({ id: 'mistral:7b', location: 'local' })
  })
})
