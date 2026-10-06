import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module resolves the app's data directory when a catalog is created.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ModelCatalog } from './modelCatalog'

function response(status: number, body?: unknown, etag?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 304 ? 'Not Modified' : 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null) },
    json: async () => body
  } as unknown as Response
}

// A slice of the shape models.dev serves: Kimi K3 on NVIDIA takes low, high or max effort and is free there; another
// model only has a thinking switch; one has no price at all.
const CATALOG = {
  nvidia: {
    id: 'nvidia',
    api: 'https://integrate.api.nvidia.com/v1',
    models: {
      'moonshotai/kimi-k3': {
        id: 'moonshotai/kimi-k3', name: 'Kimi K3', family: 'kimi-k3', reasoning: true, tool_call: true, attachment: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1_048_576, output: 131_072 }, cost: { input: 0, output: 0 }, interleaved: { field: 'reasoning_content' }, extra: 'ignored'
      },
      'z-ai/glm-5.2': { id: 'z-ai/glm-5.2', name: 'GLM-5.2', reasoning: true, reasoning_options: [{ type: 'toggle' }], limit: { context: 200_000, output: 32_000 }, cost: { input: 0, output: 0 } },
      'vendor/plain': { id: 'vendor/plain', name: 'Plain', reasoning: false, tool_call: true },
      'vendor/levels-unsaid': { id: 'vendor/levels-unsaid', name: 'Levels unsaid', reasoning: true }
    }
  },
  openai: {
    id: 'openai',
    models: {
      'gpt-x': {
        id: 'gpt-x', name: 'GPT X', reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'surprise'] }],
        limit: { context: 400_000, output: 128_000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 }
      }
    }
  }
}

describe('ModelCatalog contents', () => {
  let dir: string
  let cachePath: string
  const served = (body: unknown = CATALOG): ModelCatalog =>
    new ModelCatalog({ cachePath, url: 'https://example.test/api.json', now: () => 5_000, fetch: (async () => response(200, body, 'W/"9"')) as unknown as typeof fetch })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cubex-catalog-'))
    cachePath = join(dir, 'catalog.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the window, the limits and a price, and keeps a free model priced at zero', async () => {
    const catalog = served()
    expect((await catalog.refresh(true)).ok).toBe(true)
    const k3 = catalog.lookup('nvidia', 'moonshotai/kimi-k3')!
    expect(k3).toMatchObject({ displayName: 'Kimi K3', family: 'kimi-k3', contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsReasoning: true, supportsAttachments: true })
    expect(k3.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0, currency: 'USD', source: 'catalog' })
    const gpt = catalog.lookup('openai', 'gpt-x')!
    expect(gpt.pricing).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 })
  })

  it('does not invent a price, a window or an effort list the catalog does not give', async () => {
    const catalog = served()
    await catalog.refresh(true)
    const plain = catalog.lookup('nvidia', 'vendor/plain')!
    expect(plain.pricing).toBeUndefined()
    expect(plain.contextWindow).toBeUndefined()
    expect(plain.reasoningEfforts).toBeUndefined()
    expect(catalog.lookup('nvidia', 'vendor/levels-unsaid')!.reasoningEfforts).toBeUndefined()
  })

  it('reads the effort levels, lowest first, and drops values that are not levels', async () => {
    const catalog = served()
    await catalog.refresh(true)
    expect(catalog.lookup('nvidia', 'moonshotai/kimi-k3')!.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(catalog.lookup('openai', 'gpt-x')!.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('says a model has no effort setting when it only has a thinking switch', async () => {
    const catalog = served()
    await catalog.refresh(true)
    expect(catalog.lookup('nvidia', 'z-ai/glm-5.2')!.reasoningEfforts).toEqual([])
  })

  it('answers for the provider asked about only, and ignores case', async () => {
    const catalog = served()
    await catalog.refresh(true)
    expect(catalog.lookup('NVIDIA', 'MoonshotAI/Kimi-K3')).toBeDefined()
    expect(catalog.lookup('openai', 'moonshotai/kimi-k3')).toBeUndefined()
    expect(catalog.lookup('nvidia', 'gpt-x')).toBeUndefined()
  })

  it('finds a provider by the host of its API, and only when one provider uses it', async () => {
    const catalog = served({
      ...CATALOG,
      twin: { id: 'twin', api: 'https://integrate.api.nvidia.com/v1', models: { a: { id: 'a' } } },
      solo: { id: 'solo', api: 'https://api.solo.test/v1', models: { a: { id: 'a' } } }
    })
    await catalog.refresh(true)
    expect(catalog.providerForHost('API.SOLO.TEST')).toBe('solo')
    expect(catalog.providerForHost('integrate.api.nvidia.com')).toBeUndefined()
    expect(catalog.providerForHost('unknown.test')).toBeUndefined()
  })

  it('keeps only what it reads on disk, and reads it back the next time', async () => {
    await served().refresh(true)
    const saved = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(saved.raw.nvidia.models['moonshotai/kimi-k3']).not.toHaveProperty('extra')
    expect(saved.raw.nvidia.api).toBe('https://integrate.api.nvidia.com/v1')

    const offline = new ModelCatalog({ cachePath, url: 'https://example.test/api.json', fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch })
    expect(offline.lookup('nvidia', 'moonshotai/kimi-k3')!.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(offline.getStatus().source).toBe('catalog')
  })

  it('shares one request between callers that ask at the same time', async () => {
    let calls = 0
    const catalog = new ModelCatalog({
      cachePath, url: 'https://example.test/api.json', now: () => 5_000,
      fetch: (async () => { calls++; return response(200, CATALOG) }) as unknown as typeof fetch
    })
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.ready(1_000)])
    expect(calls).toBe(1)
  })

  it('does not wait for a download that never finishes', async () => {
    const never = new ModelCatalog({ cachePath, url: 'https://example.test/api.json', fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch })
    const started = Date.now()
    await never.ready(60)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(never.getStatus().source).toBe('builtin')
  })

  it('answers at once when a catalog is already on disk, and refreshes behind it', async () => {
    writeFileSync(cachePath, JSON.stringify({ updatedAt: 1, raw: CATALOG }), 'utf8')
    let calls = 0
    const catalog = new ModelCatalog({
      cachePath, url: 'https://example.test/api.json', now: () => 10 * 60 * 60 * 1000,
      fetch: (async () => { calls++; return response(304) }) as unknown as typeof fetch
    })
    await catalog.ready(1_000)
    expect(catalog.lookup('nvidia', 'moonshotai/kimi-k3')).toBeDefined()
    await catalog.refresh()
    expect(calls).toBe(1)
  })
})
