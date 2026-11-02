import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadFile, type FileProgress } from './hfDownload'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** Deterministic, incompressible-looking bytes so a wrong offset is always caught. */
function makeContent(n: number): Buffer {
  const b = Buffer.alloc(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
    b[i] = x & 0xff
  }
  return b
}

interface ServerOptions {
  /** Answer a Range request with the whole body and status 200. */
  ignoreRange?: boolean
  /** First request only: error the body once this many bytes were delivered. */
  failFirstAfterBytes?: number
  /** Stop delivering after this many bytes until the request is aborted. */
  hangAfterBytes?: number
  /** Replace the body bytes (same length) to simulate corruption. */
  corrupt?: boolean
  status?: number
  etag?: string
  chunk?: number
}

function fakeServer(content: Buffer, options: ServerOptions = {}) {
  const calls: Array<{ url: string; range?: string; auth?: string }> = []
  let requests = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    const range = headers.get('range') ?? undefined
    const auth = headers.get('authorization') ?? undefined
    calls.push({ url: String(input), ...(range ? { range } : {}), ...(auth ? { auth } : {}) })
    requests++
    const attempt = requests
    if (options.status && options.status !== 200) return new Response('error body', { status: options.status })

    let start = 0
    let status = 200
    if (range && !options.ignoreRange) {
      start = Number(/^bytes=(\d+)-$/.exec(range)![1])
      if (start >= content.length) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${content.length}` } })
      }
      status = 206
    }
    let body = content.subarray(start)
    if (options.corrupt) {
      body = Buffer.from(body)
      body[0] = body[0]! ^ 0xff
    }
    const responseHeaders: Record<string, string> = { 'content-length': String(body.length) }
    if (status === 206) responseHeaders['content-range'] = `bytes ${start}-${content.length - 1}/${content.length}`
    if (options.etag) responseHeaders.etag = `"${options.etag}"`

    const failAt = attempt === 1 ? options.failFirstAfterBytes : undefined
    const chunk = options.chunk ?? 1024
    let offset = 0
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          } catch {
            /* already closed */
          }
        })
      },
      async pull(controller) {
        if (failAt !== undefined && offset >= failAt) {
          controller.error(new Error('ECONNRESET'))
          return
        }
        if (options.hangAfterBytes !== undefined && offset >= options.hangAfterBytes) {
          await new Promise<void>(() => undefined) // released only by the abort listener
          return
        }
        if (offset >= body.length) {
          controller.close()
          return
        }
        const end = Math.min(body.length, offset + chunk)
        controller.enqueue(new Uint8Array(body.subarray(offset, end)))
        offset = end
      }
    })
    void controllerRef
    return new Response(stream, { status, headers: responseHeaders })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubex-dl-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const URL_ = 'https://huggingface.co/o/r/resolve/main/model.gguf'

function dest(): string {
  return join(root, 'o', 'r', 'model.gguf')
}

async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

describe('downloadFile', () => {
  it('downloads, verifies SHA-256, renames atomically and leaves no temp files', async () => {
    const content = makeContent(20_000)
    const server = fakeServer(content)
    const progress: FileProgress[] = []
    const result = await downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: content.length,
      expectedSha256: sha(content),
      fetch: server.fetch,
      onProgress: (p) => progress.push(p),
      freeBytes: async () => 10 * 1024 ** 3
    })
    expect(result).toMatchObject({ bytes: 20_000, verified: true, alreadyPresent: false, resumedFromBytes: 0 })
    expect((await readFile(dest())).equals(content)).toBe(true)
    expect(await listDir(join(root, 'o', 'r'))).toEqual(['model.gguf'])

    const downloading = progress.filter((p) => p.phase === 'downloading').map((p) => p.completedBytes)
    expect(downloading.length).toBeGreaterThan(1)
    expect([...downloading].sort((a, b) => a - b)).toEqual(downloading)
    expect(downloading.at(-1)).toBe(20_000)
    expect(progress.some((p) => p.phase === 'verifying')).toBe(true)
  })

  it('resumes a partial download with an HTTP Range request', async () => {
    const content = makeContent(10_000)
    const server = fakeServer(content)
    await mkdir(join(root, 'o', 'r'), { recursive: true })
    await writeFile(dest() + '.part', content.subarray(0, 4_000))
    await writeFile(dest() + '.part.json', JSON.stringify({ url: URL_, size: content.length, sha256: sha(content) }))
    const result = await downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: content.length,
      expectedSha256: sha(content),
      fetch: server.fetch,
      freeBytes: async () => 10 * 1024 ** 3
    })
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]!.range).toBe('bytes=4000-')
    expect(result.resumedFromBytes).toBe(4_000)
    expect((await readFile(dest())).equals(content)).toBe(true)
  })

  it('starts over when the server ignores Range and answers 200', async () => {
    const content = makeContent(8_000)
    const server = fakeServer(content, { ignoreRange: true })
    await mkdir(join(root, 'o', 'r'), { recursive: true })
    await writeFile(dest() + '.part', content.subarray(0, 3_000))
    await writeFile(dest() + '.part.json', JSON.stringify({ url: URL_, size: content.length, sha256: sha(content) }))
    const result = await downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: content.length,
      expectedSha256: sha(content),
      fetch: server.fetch,
      freeBytes: async () => 10 * 1024 ** 3
    })
    expect(result.resumedFromBytes).toBe(0)
    expect((await readFile(dest())).equals(content)).toBe(true)
  })

  it('fails on a checksum mismatch, deletes the corrupt partial file and never creates the target', async () => {
    const content = makeContent(7_000)
    const server = fakeServer(content, { corrupt: true })
    await expect(
      downloadFile({
        url: URL_,
        destPath: dest(),
        rootDir: root,
        expectedSize: content.length,
        expectedSha256: sha(content),
        fetch: server.fetch,
        freeBytes: async () => 10 * 1024 ** 3
      })
    ).rejects.toMatchObject({ code: 'checksum', message: expect.stringMatching(/checksum/i) })
    expect(await listDir(join(root, 'o', 'r'))).toEqual([])
  })

  it('refuses before downloading anything when free disk space is too small, with a clear message', async () => {
    const content = makeContent(7_000)
    const server = fakeServer(content)
    const err = await downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: 5 * 1024 ** 3,
      fetch: server.fetch,
      freeBytes: async () => 1 * 1024 ** 3
    }).catch((e: unknown) => e as Error & { code?: string })
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('disk_space')
    expect((err as Error).message).toMatch(/not enough free disk space/i)
    expect((err as Error).message).toMatch(/5\.\d GB|5 GB/)
    expect((err as Error).message).toMatch(/1\.\d GB|1 GB/)
    expect(server.calls).toHaveLength(0)
  })

  it('cleans up the partial file and rejects with a cancelled error when aborted', async () => {
    const content = makeContent(50_000)
    const server = fakeServer(content, { hangAfterBytes: 5_000 })
    const controller = new AbortController()
    const p = downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: content.length,
      expectedSha256: sha(content),
      fetch: server.fetch,
      signal: controller.signal,
      freeBytes: async () => 10 * 1024 ** 3,
      onProgress: (e) => {
        if (e.phase === 'downloading' && e.completedBytes >= 5_000) controller.abort()
      }
    })
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(await listDir(join(root, 'o', 'r')).catch(() => [])).toEqual([])
  })

  it('sends the Authorization header only on the first hop it was given for', async () => {
    const content = makeContent(2_000)
    const server = fakeServer(content)
    await downloadFile({
      url: URL_,
      destPath: dest(),
      rootDir: root,
      expectedSize: content.length,
      fetch: server.fetch,
      headers: { authorization: 'Bearer hf_secret' },
      freeBytes: async () => 10 * 1024 ** 3
    })
    expect(server.calls[0]!.auth).toBe('Bearer hf_secret')
  })

  it('refuses to write through a directory junction or symlink that leaves the models directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cubex-outside-'))
    try {
      await symlink(outside, join(root, 'o'), 'junction')
      const content = makeContent(2_000)
      const server = fakeServer(content)
      await expect(
        downloadFile({
          url: URL_,
          destPath: dest(),
          rootDir: root,
          expectedSize: content.length,
          fetch: server.fetch,
          freeBytes: async () => 10 * 1024 ** 3
        })
      ).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(await readdir(outside)).toEqual([])
      expect(server.calls).toHaveLength(0)
    } finally {
      // Remove the link itself first so the recursive cleanup never walks into `outside`.
      await unlink(join(root, 'o')).catch(() => undefined)
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a destination outside the root directory', async () => {
    const content = makeContent(1_000)
    const server = fakeServer(content)
    await expect(
      downloadFile({
        url: URL_,
        destPath: join(root, '..', 'escape.gguf'),
        rootDir: root,
        expectedSize: content.length,
        fetch: server.fetch,
        freeBytes: async () => 10 * 1024 ** 3
      })
    ).rejects.toMatchObject({ code: 'unsafe_path' })
    expect(server.calls).toHaveLength(0)
  })
})
