import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pullGguf } from './ggufPull'
import type { PullProgressUpdate } from '../runtimes/LocalRuntime'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
    b[i] = x & 0xff
  }
  return b
}

/** A fake Hugging Face: the tree API plus resolve URLs with Range support. */
function fakeHf(files: Record<string, Buffer>, options: { hangAfterBytes?: number } = {}) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://huggingface.co/api/models/o/r/tree/main?recursive=true') {
      const tree = Object.entries(files).map(([path, buf]) => ({
        type: 'file',
        path,
        size: buf.length,
        lfs: { oid: sha(buf), size: buf.length, pointerSize: 134 }
      }))
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const prefix = 'https://huggingface.co/o/r/resolve/main/'
    if (url.startsWith(prefix)) {
      const buf = files[decodeURIComponent(url.slice(prefix.length))]
      if (!buf) return new Response('missing', { status: 404 })
      const range = new Headers(init?.headers).get('range')
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0
      const body = buf.subarray(start)
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'))
            } catch {
              /* closed */
            }
          })
        },
        async pull(controller) {
          if (options.hangAfterBytes !== undefined && offset >= options.hangAfterBytes) {
            await new Promise<void>(() => undefined)
          }
          if (offset >= body.length) return controller.close()
          const end = Math.min(body.length, offset + 512)
          controller.enqueue(new Uint8Array(body.subarray(offset, end)))
          offset = end
        }
      })
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          'content-length': String(body.length),
          ...(range ? { 'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}` } : {})
        }
      })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

let modelsDir: string
beforeEach(async () => {
  modelsDir = await mkdtemp(join(tmpdir(), 'cubex-models-'))
})
afterEach(async () => {
  await rm(modelsDir, { recursive: true, force: true })
})

const roomy = async (): Promise<number> => 100 * 1024 ** 3
const common = { retryDelayMs: () => 0, freeBytes: roomy }

describe('pullGguf', () => {
  it('downloads the file for a quantization into owner/repo and returns its path', async () => {
    const q4 = bytes(6_000, 1)
    const q8 = bytes(9_000, 2)
    const hf = fakeHf({ 'Model-Q4_K_M.gguf': q4, 'Model-Q8_0.gguf': q8 })
    const events: PullProgressUpdate[] = []
    const result = await pullGguf({
      modelRef: 'o/r:Q4_K_M',
      modelsDir,
      fetch: hf.fetch,
      onProgress: (p) => events.push(p),
      ...common
    })
    expect(result.modelPath).toBe(join(modelsDir, 'o', 'r', 'Model-Q4_K_M.gguf'))
    expect(result.verified).toBe(true)
    expect(await readdir(join(modelsDir, 'o', 'r'))).toEqual(['Model-Q4_K_M.gguf'])
    expect(hf.calls.some((u) => u.includes('Q8_0'))).toBe(false)

    const downloading = events.filter((e) => e.phase === 'downloading')
    expect(downloading.length).toBeGreaterThan(0)
    expect(downloading.at(-1)).toMatchObject({ completedBytes: 6_000, totalBytes: 6_000, fileName: 'Model-Q4_K_M.gguf', fileIndex: 1, fileCount: 1 })
    expect(events.some((e) => e.phase === 'preparing')).toBe(true)
    expect(events.some((e) => e.phase === 'verifying')).toBe(true)
  })

  it('downloads every part of a split model into one folder and reports one combined progress', async () => {
    const p1 = bytes(5_000, 3)
    const p2 = bytes(3_000, 4)
    const hf = fakeHf({
      'Big-Q4_K_M-00001-of-00002.gguf': p1,
      'Big-Q4_K_M-00002-of-00002.gguf': p2
    })
    const events: PullProgressUpdate[] = []
    const result = await pullGguf({ modelRef: 'o/r:Q4_K_M', modelsDir, fetch: hf.fetch, onProgress: (p) => events.push(p), ...common })
    expect(result.modelPath).toBe(join(modelsDir, 'o', 'r', 'Big-Q4_K_M-00001-of-00002.gguf'))
    expect(result.files).toHaveLength(2)
    expect((await readdir(join(modelsDir, 'o', 'r'))).sort()).toEqual([
      'Big-Q4_K_M-00001-of-00002.gguf',
      'Big-Q4_K_M-00002-of-00002.gguf'
    ])
    const completed = events.filter((e) => e.phase === 'downloading').map((e) => e.completedBytes!)
    expect([...completed].sort((a, b) => a - b)).toEqual(completed)
    expect(completed.at(-1)).toBe(8_000)
    expect(events.filter((e) => e.phase === 'downloading').every((e) => e.totalBytes === 8_000)).toBe(true)
    expect(events.some((e) => e.fileIndex === 2 && e.fileCount === 2)).toBe(true)
  })

  it('checks free space for the whole model before downloading any part', async () => {
    const hf = fakeHf({
      'Big-Q4_K_M-00001-of-00002.gguf': bytes(5_000, 3),
      'Big-Q4_K_M-00002-of-00002.gguf': bytes(5_000, 4)
    })
    await expect(
      pullGguf({
        modelRef: 'o/r:Q4_K_M',
        modelsDir,
        fetch: hf.fetch,
        onProgress: () => undefined,
        retryDelayMs: () => 0,
        reserveBytes: 0,
        freeBytes: async () => 6_000 // enough for one part, not both
      })
    ).rejects.toMatchObject({ code: 'disk_space', message: expect.stringMatching(/not enough free disk space/i) })
    expect(hf.calls.filter((u) => u.includes('/resolve/'))).toEqual([])
  })

  it('counts bytes already on disk toward the free-space check', async () => {
    const p1 = bytes(5_000, 3)
    const p2 = bytes(5_000, 4)
    const files = { 'Big-Q4_K_M-00001-of-00002.gguf': p1, 'Big-Q4_K_M-00002-of-00002.gguf': p2 }
    const first = fakeHf(files)
    await pullGguf({ modelRef: 'o/r:Q4_K_M', modelsDir, fetch: first.fetch, onProgress: () => undefined, ...common })
    // Everything is present now, so a second pull needs no free space at all.
    const second = fakeHf(files)
    const result = await pullGguf({
      modelRef: 'o/r:Q4_K_M',
      modelsDir,
      fetch: second.fetch,
      onProgress: () => undefined,
      retryDelayMs: () => 0,
      reserveBytes: 0,
      freeBytes: async () => 10
    })
    expect(result.files.every((f) => f.alreadyPresent)).toBe(true)
    expect(second.calls.filter((u) => u.includes('/resolve/'))).toEqual([])
  })

  it('refuses a link to another site before any request', async () => {
    const hf = fakeHf({})
    await expect(
      pullGguf({ modelRef: 'https://example.com/o/r/resolve/main/x.gguf', modelsDir, fetch: hf.fetch, onProgress: () => undefined, ...common })
    ).rejects.toThrow(/Hugging Face/)
    expect(hf.calls).toEqual([])
  })

  it('cancels mid-download, removes the partial file and reports cancelled', async () => {
    const hf = fakeHf({ 'Model-Q4_K_M.gguf': bytes(40_000, 5) }, { hangAfterBytes: 2_048 })
    const controller = new AbortController()
    const p = pullGguf({
      modelRef: 'o/r:Q4_K_M',
      modelsDir,
      fetch: hf.fetch,
      signal: controller.signal,
      onProgress: (e) => {
        if (e.phase === 'downloading' && (e.completedBytes ?? 0) >= 2_048) controller.abort()
      },
      ...common
    })
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readdir(join(modelsDir, 'o', 'r'))).toEqual([])
  })

  it('accepts an exact file option and revision', async () => {
    const hf = fakeHf({ 'Model-Q4_K_M.gguf': bytes(2_000, 6) })
    const result = await pullGguf({
      modelRef: 'o/r',
      file: 'Model-Q4_K_M.gguf',
      modelsDir,
      fetch: hf.fetch,
      onProgress: () => undefined,
      ...common
    })
    expect(result.files[0]!.verified).toBe(true)
  })
})
