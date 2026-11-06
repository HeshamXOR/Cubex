import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module resolves the app's data directory when a catalog is created.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ModelCatalog } from './modelCatalog'

const RAW = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: { 'claude-x': { id: 'claude-x', name: 'Claude X', limit: { context: 200_000, output: 8_192 } } }
  }
}

function response(status: number, body?: unknown, etag?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 304 ? 'Not Modified' : 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null) },
    json: async () => body
  } as unknown as Response
}

describe('finding a model whichever provider lists it', () => {
  const entry = (extra: object) => ({ name: 'M', ...extra })
  const catalogOf = (raw: object): ModelCatalog => {
    const dir = mkdtempSync(join(tmpdir(), 'cubex-catalog-'))
    const cachePath = join(dir, 'catalog.json')
    writeFileSync(cachePath, JSON.stringify({ etag: 'x', updatedAt: Date.now(), raw }))
    return new ModelCatalog({ cachePath })
  }

  it('prefers the company that makes the model over a reseller', () => {
    const catalog = catalogOf({
      reseller: { id: 'reseller', models: { 'claude-x-5': entry({ cost: { input: 9, output: 9 }, limit: { context: 1, output: 1 } }) } },
      anthropic: { id: 'anthropic', models: { 'claude-x-5': entry({ cost: { input: 2, output: 10 } }) } }
    })
    expect(catalog.lookupAny('claude-x-5')?.pricing?.inputPerMTok).toBe(2)
  })

  it('otherwise takes whoever says the most, and ignores a vendor prefix on the name', () => {
    const catalog = catalogOf({
      thin: { id: 'thin', models: { 'some-model': entry({}) } },
      rich: { id: 'rich', models: { 'vendor/some-model': entry({ cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 100_000, output: 1_000 } }) } }
    })
    expect(catalog.lookupAny('other/some-model')?.contextWindow).toBe(100_000)
    expect(catalog.lookupAny('nothing-like-it')).toBeUndefined()
  })
})

describe('ModelCatalog refresh', () => {
  let dir: string
  let cachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cubex-catalog-'))
    cachePath = join(dir, 'catalog.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a 304 with an unusable cache as a failure and drops the stored etag', async () => {
    // An ETag with no payload: the state that used to brick the catalog.
    writeFileSync(cachePath, JSON.stringify({ etag: 'W/"1"', updatedAt: 1_000 }), 'utf8')
    const calls: Array<Record<string, string>> = []
    const catalog = new ModelCatalog({
      cachePath,
      url: 'https://example.test/api.json',
      now: () => 2_000_000,
      fetch: (async (_url: string, init?: RequestInit) => {
        calls.push((init?.headers ?? {}) as Record<string, string>)
        return response(304, undefined, 'W/"1"')
      }) as unknown as typeof fetch
    })

    const first = await catalog.refresh(true)
    expect(first.ok).toBe(false)
    expect(first.error).toContain('cached catalog')
    expect(catalog.getStatus().source).toBe('builtin')
    expect(readFileSync(cachePath, 'utf8')).not.toContain('W/"1"')

    // The next fetch must be unconditional, or the server keeps answering 304.
    await catalog.refresh()
    expect(calls).toHaveLength(2)
    expect(calls[1]!['If-None-Match']).toBeUndefined()
  })

  it('keeps the cached catalog on a healthy 304', async () => {
    writeFileSync(cachePath, JSON.stringify({ etag: 'W/"2"', updatedAt: 1_000, raw: RAW }), 'utf8')
    const catalog = new ModelCatalog({
      cachePath,
      url: 'https://example.test/api.json',
      now: () => 2_000_000,
      fetch: (async () => response(304)) as unknown as typeof fetch
    })

    const res = await catalog.refresh(true)
    expect(res.ok).toBe(true)
    const status = catalog.getStatus()
    expect(status.source).toBe('catalog')
    expect(status.updatedAt).toBe(2_000_000)
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).raw).toEqual(RAW)
  })

  it('reports a response with no usable models as a failure', async () => {
    const catalog = new ModelCatalog({
      cachePath,
      url: 'https://example.test/api.json',
      now: () => 2_000_000,
      fetch: (async () => response(200, {}, 'W/"3"')) as unknown as typeof fetch
    })

    const res = await catalog.refresh(true)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no usable models')
    expect(catalog.getStatus().source).toBe('builtin')
  })
})
