import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomProvider, getPath, setPath } from './CustomProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'

describe('dot-path helpers', () => {
  it('getPath reads nested values', () => {
    expect(getPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
    expect(getPath({ a: 1 }, 'a.missing')).toBeUndefined()
    expect(getPath({ choices: [{ text: 'reply' }] }, 'choices.0.text')).toBe('reply')
    expect(getPath({ choices: [{ text: 'reply' }] }, 'choices.1.text')).toBeUndefined()
  })
  it('setPath writes nested values, creating objects', () => {
    const obj: Record<string, unknown> = {}
    setPath(obj, 'input.prompt', 'hello')
    expect(obj).toEqual({ input: { prompt: 'hello' } })
  })

  it('writes numeric fields and existing array entries', () => {
    const obj: Record<string, unknown> = { messages: [{ role: 'user' }] }
    setPath(obj, 'messages.0.content', 'hello')
    setPath(obj, 'parameters.0.value', 42)
    expect(obj).toEqual({ messages: [{ role: 'user', content: 'hello' }], parameters: { 0: { value: 42 } } })
  })

  it.each(['__proto__.polluted', 'constructor.prototype.polluted', 'input.__proto__.polluted', 'input.constructor', 'input.prototype', 'input..prompt'])(
    'rejects unsafe path %s before mutating the target', (path) => {
      const obj: Record<string, unknown> = {}
      expect(() => setPath(obj, path, 'bad')).toThrow(/Mapping paths/)
      expect(obj).toEqual({})
      expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    }
  )

  it('does not follow inherited values or invoke inherited accessors', () => {
    const inherited = { input: { prompt: 'original' } }
    const obj = Object.create(inherited) as Record<string, unknown>
    expect(getPath(obj, 'input.prompt')).toBeUndefined()
    setPath(obj, 'input.prompt', 'new')
    expect(inherited.input.prompt).toBe('original')
    expect(getPath(obj, 'input.prompt')).toBe('new')

    const get = vi.fn(() => ({ prompt: 'original' }))
    const set = vi.fn()
    const accessorParent = Object.defineProperty({}, 'input', { get, set })
    const accessorChild = Object.create(accessorParent) as Record<string, unknown>
    expect(getPath(accessorChild, 'input.prompt')).toBeUndefined()
    setPath(accessorChild, 'input.prompt', 'new')
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(accessorChild).toEqual({ input: { prompt: 'new' } })
  })

  it('does not extract unsafe fields even when they are own JSON properties', () => {
    const obj: unknown = JSON.parse('{"__proto__":{"text":"bad"},"constructor":{"text":"bad"},"prototype":{"text":"bad"}}')
    for (const field of ['__proto__', 'constructor', 'prototype']) {
      expect(getPath(obj, `${field}.text`)).toBeUndefined()
    }
    expect(getPath({ choices: ['reply'] }, 'choices.')).toBeUndefined()
    expect(getPath({ choices: ['reply'] }, 'choices.01')).toBeUndefined()
  })

  it('does not read inherited array entries', () => {
    const values = new Array(1)
    Object.setPrototypeOf(values, { 0: 'inherited' })
    expect(getPath({ values }, 'values.0')).toBeUndefined()
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

  it.each(['promptField', 'modelField', 'streamField', 'responseTextPath'] as const)(
    'rejects unsafe %s before fetching or allocating request resources', async (field) => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()
      const addListener = vi.spyOn(controller.signal, 'addEventListener')
      const config = cfg()
      config.mapping = { ...config.mapping, [field]: 'nested.__proto__.polluted' }
      const provider = new CustomProvider(config)

      await expect(collect(provider.streamMessage(
        { model: 'my-model', messages: [userMessage('hello')] },
        { signal: controller.signal, timeout: { totalMs: 60_000 } }
      ))).rejects.toMatchObject({ category: 'INVALID_REQUEST', retryable: false, message: expect.stringContaining(field) })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(addListener).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      await expect(provider.validateConfiguration()).resolves.toMatchObject({ ok: false, message: expect.stringContaining(field) })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('releases the timeout and abort listener when body construction fails', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const message = userMessage('hello')
    Object.defineProperty(message, 'content', { get: () => { throw new Error('Unreadable message') } })

    await expect(collect(new CustomProvider(cfg()).streamMessage(
      { model: 'my-model', messages: [message] }, { signal: controller.signal, timeout: { totalMs: 60_000 } }
    ))).rejects.toMatchObject({ message: 'Unreadable message' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
