import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomProvider, getPath, setPath } from './CustomProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'

describe('dot-path helpers', () => {
  it('getPath reads nested values', () => {
    expect(getPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
    expect(getPath({ a: 1 }, 'a.missing')).toBeUndefined()
  })
  it('setPath writes nested values, creating objects', () => {
    const obj: Record<string, unknown> = {}
    setPath(obj, 'input.prompt', 'hello')
    expect(obj).toEqual({ input: { prompt: 'hello' } })
  })
})

function cfg(): ProviderConfig {
  return {
    id: 'custom',
    kind: 'custom',
    name: 'Custom REST',
    accessType: 'api',
    baseUrl: 'https://api.test/generate',
    auth: { type: 'bearer' },
    enabled: true,
    mapping: {
      shape: 'rest',
      method: 'POST',
      promptField: 'input.prompt',
      modelField: 'model',
      responseTextPath: 'result.text',
      sse: false
    }
  }
}

async function collect(gen: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const out: AIStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

afterEach(() => vi.restoreAllMocks())

describe('CustomProvider REST shape', () => {
  it('builds a body via dot-paths and extracts text from responseTextPath', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // Assert the outgoing body was mapped correctly.
      const body = JSON.parse(String(init?.body))
      expect(body.input.prompt).toContain('hi there')
      expect(body.model).toBe('my-model')
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ result: { text: 'mapped reply' } })
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new CustomProvider(cfg(), 'secret')
    const events = await collect(
      provider.streamMessage({ model: 'my-model', messages: [userMessage('hi there')] })
    )
    // The adapter emits normalized deltas; the extracted text should appear.
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('mapped reply')
    expect(events.some((e) => e.type === 'stop')).toBe(true)
  })
})
