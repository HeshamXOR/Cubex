import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blobBytesOnDisk,
  fetchOllamaManifest,
  ollamaModelsDir,
  parseOllamaManifest,
  parseOllamaModelRef,
  type ManifestBlob
} from './ollamaRegistry'

const digest = (char: string): string => `sha256:${char.repeat(64)}`
const stem = (char: string): string => `sha256-${char.repeat(64)}`

describe('parseOllamaModelRef', () => {
  it.each([
    ['llama3.1:8b', { host: 'registry.ollama.ai', namespace: 'library', name: 'llama3.1', tag: '8b' }],
    ['llama3.1', { host: 'registry.ollama.ai', namespace: 'library', name: 'llama3.1', tag: 'latest' }],
    ['someone/model:Q4_K_M', { host: 'registry.ollama.ai', namespace: 'someone', name: 'model', tag: 'Q4_K_M' }],
    ['hf.co/owner/repo:Q4_K_M', { host: 'hf.co', namespace: 'owner', name: 'repo', tag: 'Q4_K_M' }],
    ['localhost:5000/team/model:1', { host: 'localhost:5000', namespace: 'team', name: 'model', tag: '1' }],
    ['  qwen3:8b  ', { host: 'registry.ollama.ai', namespace: 'library', name: 'qwen3', tag: '8b' }]
  ])('reads %j', (input, expected) => {
    expect(parseOllamaModelRef(input)).toEqual(expected)
  })

  it.each(['', '   ', '../etc/passwd', 'a/b/c/d', 'two words', 'a:b:c', 'model:', ':tag', 'a//b', `x${'y'.repeat(300)}`, 'model\n:tag'])(
    'rejects %j, so it never reaches a URL',
    (input) => {
      expect(parseOllamaModelRef(input)).toBeUndefined()
    }
  )
})

describe('ollamaModelsDir', () => {
  it('prefers OLLAMA_MODELS and ignores a blank one', () => {
    expect(ollamaModelsDir({ OLLAMA_MODELS: 'D:\\models' }, 'C:\\Users\\a')).toBe('D:\\models')
    expect(ollamaModelsDir({ OLLAMA_MODELS: '  ' }, 'home')).toBe(join('home', '.ollama', 'models'))
  })

  it('falls back to the home folder', () => {
    expect(ollamaModelsDir({}, 'home')).toBe(join('home', '.ollama', 'models'))
  })
})

describe('parseOllamaManifest', () => {
  const manifest = {
    config: { digest: digest('a'), size: 487 },
    layers: [
      { digest: digest('b'), size: 4_920_738_944 },
      { digest: digest('c'), size: 1481 }
    ]
  }

  it('lists the config and every layer', () => {
    expect(parseOllamaManifest(manifest)).toEqual([
      { digest: digest('a'), size: 487 },
      { digest: digest('b'), size: 4_920_738_944 },
      { digest: digest('c'), size: 1481 }
    ])
  })

  it.each([
    ['not an object', 'text'],
    ['no layers', { config: manifest.config }],
    ['an empty layer list', { layers: [] }],
    ['a layer without a digest', { layers: [{ size: 1 }] }],
    ['a digest that is not sha256', { layers: [{ digest: 'md5:abc', size: 1 }] }],
    ['a negative size', { layers: [{ digest: digest('b'), size: -1 }] }],
    ['a fractional size', { layers: [{ digest: digest('b'), size: 1.5 }] }],
    ['a size that is not a number', { layers: [{ digest: digest('b'), size: '10' }] }],
    ['too many layers', { layers: Array.from({ length: 65 }, () => ({ digest: digest('b'), size: 1 })) }]
  ])('refuses %s', (_name, json) => {
    expect(parseOllamaManifest(json)).toBeUndefined()
  })
})

describe('fetchOllamaManifest', () => {
  const ref = { host: 'registry.ollama.ai', namespace: 'library', name: 'llama3.1', tag: '8b' }
  const body = { config: { digest: digest('a'), size: 10 }, layers: [{ digest: digest('b'), size: 100 }] }

  it('asks the registry for the manifest of that tag', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)))
    const blobs = await fetchOllamaManifest(ref, { fetch: fetchMock as unknown as typeof fetch })
    expect(blobs?.reduce((sum, blob) => sum + blob.size, 0)).toBe(110)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://registry.ollama.ai/v2/library/llama3.1/manifests/8b')
    expect(init.headers).toMatchObject({ accept: 'application/vnd.docker.distribution.manifest.v2+json' })
  })

  it('does not ask a registry other than the default one', async () => {
    const fetchMock = vi.fn()
    expect(await fetchOllamaManifest({ ...ref, host: 'hf.co' }, { fetch: fetchMock as unknown as typeof fetch })).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports nothing for an unknown model, a bad reply or an unreachable registry', async () => {
    const notFound = vi.fn(async () => new Response('{"errors":[]}', { status: 404 }))
    expect(await fetchOllamaManifest(ref, { fetch: notFound as unknown as typeof fetch })).toBeUndefined()
    const notJson = vi.fn(async () => new Response('<html>'))
    expect(await fetchOllamaManifest(ref, { fetch: notJson as unknown as typeof fetch })).toBeUndefined()
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await fetchOllamaManifest(ref, { fetch: offline as unknown as typeof fetch })).toBeUndefined()
  })

  it('gives up when the registry does not answer in time', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const started = Date.now()
    expect(await fetchOllamaManifest(ref, { fetch: hang as unknown as typeof fetch, timeoutMs: 30 })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const pending = fetchOllamaManifest(ref, { fetch: hang as unknown as typeof fetch, signal: controller.signal })
    controller.abort()
    expect(await pending).toBeUndefined()
  })
})

describe('blobBytesOnDisk', () => {
  let dir: string
  const blobs: ManifestBlob[] = [
    { digest: digest('a'), size: 1000 },
    { digest: digest('b'), size: 5000 }
  ]
  const file = async (name: string, size: number): Promise<void> => writeFile(join(dir, 'blobs', name), Buffer.alloc(size))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cubex-blobs-'))
    await mkdir(join(dir, 'blobs'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('counts a finished blob in full', async () => {
    await file(stem('a'), 1000)
    expect(await blobBytesOnDisk(dir, blobs)).toBe(1000)
  })

  it('counts an interrupted download by the partial files it left', async () => {
    await file(`${stem('b')}-partial`, 2000)
    await file(`${stem('b')}-partial-0`, 500)
    expect(await blobBytesOnDisk(dir, blobs)).toBe(2500)
  })

  it('does not count a final file of the wrong size as present', async () => {
    await file(stem('a'), 400)
    expect(await blobBytesOnDisk(dir, blobs)).toBe(0)
  })

  it('never counts more than the blob is worth', async () => {
    await file(`${stem('a')}-partial`, 9000)
    expect(await blobBytesOnDisk(dir, blobs)).toBe(1000)
  })

  it('ignores blobs that belong to other models', async () => {
    await file(stem('f'), 7000)
    expect(await blobBytesOnDisk(dir, blobs)).toBe(0)
  })

  it('is zero when Ollama has not created its blobs folder yet', async () => {
    expect(await blobBytesOnDisk(join(dir, 'missing'), blobs)).toBe(0)
  })
})
