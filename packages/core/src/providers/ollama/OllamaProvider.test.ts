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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  it('forwards thinking before answer or tool generation finishes', async () => {
    const encoder = new TextEncoder()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const provider = new OllamaProvider(cfg())
    const events: AIStreamEvent[] = []
    const pending = (async () => {
      for await (const event of provider.streamMessage({ model: 'qwen3:8b', messages: [userMessage('Make a plan')] })) events.push(event)
    })()
    try {
      source.enqueue(encoder.encode(JSON.stringify({ message: { thinking: 'Checking the constraints.', content: '' }, done: false }) + '\n'))
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Checking the constraints.' }))
      expect(events.some((event) => event.type === 'text_delta' || event.type === 'stop')).toBe(false)
    } finally {
      source.enqueue(encoder.encode(JSON.stringify({ message: { content: 'The plan is ready.' }, done: true }) + '\n'))
      source.close()
      await pending
    }
    expect(events.map((event) => event.type)).toEqual(['start', 'reasoning_delta', 'text_delta', 'stop'])
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

describe('OllamaProvider stop reasons', () => {
  it('reports tool_use after tool calls and length on truncation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([
      JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })
    ])))
    const tools = await collect(new OllamaProvider(cfg()).streamMessage({ model: 'm', messages: [userMessage('hi')], stream: true }))
    expect(tools.find((e) => e.type === 'stop')).toMatchObject({ stopReason: 'tool_use' })

    vi.stubGlobal('fetch', vi.fn(async () => ndjson([
      JSON.stringify({ message: { content: 'cut' }, done: true, done_reason: 'length' })
    ])))
    const cut = await collect(new OllamaProvider(cfg()).streamMessage({ model: 'm', messages: [userMessage('hi')], stream: true }))
    expect(cut.find((e) => e.type === 'stop')).toMatchObject({ stopReason: 'length' })
  })
})
