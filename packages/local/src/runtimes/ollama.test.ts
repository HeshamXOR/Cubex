import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaRuntime } from './OllamaRuntime'
import type { PullProgressUpdate } from './LocalRuntime'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function ndjsonStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(lines[i] + '\n'))
      i++
    }
  })
  return { ok: true, status: 200, body } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

describe('OllamaRuntime.detect', () => {
  it('reports running when /api/version responds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ version: '0.5.1' })))
    const det = await new OllamaRuntime().detect()
    expect(det).toMatchObject({ installed: true, running: true, version: '0.5.1' })
  })
})

describe('OllamaRuntime.listModels', () => {
  it('parses /api/tags into model entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        models: [
          {
            name: 'llama3.1:8b',
            size: 4_700_000_000,
            details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' }
          }
        ]
      })
    ))
    const models = await new OllamaRuntime().listModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'llama3.1:8b',
      runtime: 'ollama',
      parameterCount: 8,
      quantization: 'Q4_K_M',
      family: 'llama'
    })
  })
})

/** A streaming response whose body the test controls; `onCancel` fires when the reader cancels it. */
function controlledStream(
  lines: string[],
  opts: { hang?: boolean; signal?: AbortSignal; onCancel?: () => void; beforeLine?: (i: number) => void } = {}
): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      opts.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        } catch {
          /* already closed */
        }
      })
    },
    async pull(controller) {
      if (i >= lines.length) {
        if (opts.hang) await new Promise<void>(() => undefined)
        controller.close()
        return
      }
      opts.beforeLine?.(i)
      controller.enqueue(encoder.encode(lines[i] + '\n'))
      i++
    },
    cancel() {
      opts.onCancel?.()
    }
  })
  return new Response(body, { status: 200 })
}

describe('OllamaRuntime.pull layers, cancel and failure handling', () => {
  it('aggregates progress across layers so it never moves backwards', async () => {
    const lines = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 0 }),
      JSON.stringify({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 500 }),
      JSON.stringify({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 1000 }),
      JSON.stringify({ status: 'pulling bbb', digest: 'sha256:bbb', total: 100, completed: 0 }),
      JSON.stringify({ status: 'pulling bbb', digest: 'sha256:bbb', total: 100, completed: 100 }),
      JSON.stringify({ status: 'verifying sha256 digest' }),
      JSON.stringify({ status: 'writing manifest' }),
      JSON.stringify({ status: 'success' })
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonStreamResponse(lines)))
    const updates: PullProgressUpdate[] = []
    await new OllamaRuntime().pull('llama3.1:8b', (p) => updates.push(p))

    const completed = updates.filter((u) => u.completedBytes !== undefined).map((u) => u.completedBytes!)
    expect([...completed].sort((a, b) => a - b)).toEqual(completed)
    expect(updates.find((u) => u.totalBytes === 1100)).toBeDefined()
    expect(updates.map((u) => u.phase)).toEqual(
      expect.arrayContaining(['preparing', 'downloading', 'verifying', 'finalizing', 'done'])
    )
    expect(updates.at(-1)).toMatchObject({ status: 'success', phase: 'done', done: true })
    const lastWithBytes = updates.filter((u) => u.completedBytes !== undefined).at(-1)!
    expect(lastWithBytes.completedBytes).toBe(1100)
    expect(lastWithBytes.totalBytes).toBe(1100)
    // Layer digests are noise for a person; the status says what is happening instead.
    expect(updates.some((u) => /pulling [0-9a-f]{3,}/i.test(u.status))).toBe(false)
  })

  it('reports cancelled (not an error) when aborted before the response arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')))
          })
      )
    )
    const controller = new AbortController()
    const updates: PullProgressUpdate[] = []
    const p = new OllamaRuntime().pull('m', (u) => updates.push(u), controller.signal)
    controller.abort()
    await p
    expect(updates.at(-1)).toMatchObject({ status: 'cancelled', phase: 'cancelled', done: true })
    expect(updates.filter((u) => u.done)).toHaveLength(1)
  })

  it('cancels cleanly mid-stream, closing the connection', async () => {
    let cancelled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        // The body does not error on abort by itself, so the runtime must cancel its reader.
        controlledStream([JSON.stringify({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 100 })], {
          hang: true,
          onCancel: () => {
            cancelled = true
          }
        })
      )
    )
    const controller = new AbortController()
    const updates: PullProgressUpdate[] = []
    await new OllamaRuntime().pull(
      'm',
      (u) => {
        updates.push(u)
        if (u.completedBytes === 100) controller.abort()
      },
      controller.signal
    )
    expect(updates.at(-1)).toMatchObject({ status: 'cancelled', phase: 'cancelled', done: true })
    expect(updates.filter((u) => u.done)).toHaveLength(1)
    expect(cancelled).toBe(true)
  })

  it('reports an error when the stream ends before the pull finished', async () => {
    const lines = [JSON.stringify({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 400 })]
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonStreamResponse(lines)))
    const updates: PullProgressUpdate[] = []
    await new OllamaRuntime().pull('m', (u) => updates.push(u))
    expect(updates.at(-1)).toMatchObject({ status: 'error', phase: 'error', done: true })
    expect(updates.at(-1)!.error).toMatch(/closed|before|incomplete/i)
  })
})

describe('OllamaRuntime pull failures say what to do', () => {
  const failureOf = async (fetchImpl: () => Promise<Response>): Promise<PullProgressUpdate> => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
    const updates: PullProgressUpdate[] = []
    await new OllamaRuntime('http://127.0.0.1:11434').pull('m', (u) => updates.push(u))
    return updates.at(-1)!
  }

  it('tells the person to start Ollama when it cannot be reached, without the noise of "fetch failed"', async () => {
    const last = await failureOf(async () => {
      throw new TypeError('fetch failed')
    })
    expect(last).toMatchObject({ status: 'error', errorCode: 'runtime_unreachable', done: true })
    expect(last.error).toBe('Could not reach Ollama at http://127.0.0.1:11434. Make sure Ollama is running, then try again.')
  })
})

describe('OllamaRuntime.estimatePull and modelsDir', () => {
  const manifest = {
    config: { digest: `sha256:${'a'.repeat(64)}`, size: 487 },
    layers: [
      { digest: `sha256:${'b'.repeat(64)}`, size: 4_920_738_944 },
      { digest: `sha256:${'c'.repeat(64)}`, size: 1481 }
    ]
  }
  const registry = (): typeof fetch => (async () => new Response(JSON.stringify(manifest))) as unknown as typeof fetch

  it('sizes a model from the registry, counting what is already on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cubex-ollama-'))
    try {
      await mkdir(join(dir, 'blobs'))
      await writeFile(join(dir, 'blobs', `sha256-${'c'.repeat(64)}`), Buffer.alloc(1481))
      const runtime = new OllamaRuntime('http://127.0.0.1:11434', { modelsDir: dir, registryFetch: registry() })
      expect(await runtime.estimatePull('llama3.1:8b')).toEqual({
        totalBytes: 487 + 4_920_738_944 + 1481,
        remainingBytes: 487 + 4_920_738_944,
        source: 'registry'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
