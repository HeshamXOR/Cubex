import type { ReviewFile, ReviewHunk } from '../../../../../shared/ipc'

/**
 * The hunks the preview's review panel starts with: the three files of the seeded story, split the way the main process
 * splits them. Hunk ids and file hashes are made up, but have the shape of the real ones (sha1 and sha256 in hex).
 */

/** A stable stand-in for a digest: `length` hex characters from `text`. */
export function fakeDigest(text: string, length: number): string {
  let out = ''
  for (let round = 0; out.length < length; round++) {
    let h1 = 0xdeadbeef ^ round
    let h2 = 0x41c6ce57 ^ round
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      h1 = Math.imul(h1 ^ code, 2654435761)
      h2 = Math.imul(h2 ^ code, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    out += (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** One hunk from its lines, each starting with ' ' (unchanged), '+' (added) or '-' (removed). */
function hunkOf(path: string, oldStart: number, newStart: number, lines: string[]): ReviewHunk {
  const count = (tags: string): number => lines.filter((line) => tags.includes(line[0] ?? '')).length
  const oldLines = count(' -')
  const newLines = count(' +')
  return {
    id: fakeDigest(`${path}\n${lines.join('\n')}`, 40),
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart, oldLines, newStart, newLines, lines, state: 'pending'
  }
}

/** The hunks of a file from where each starts in the old file; where each starts in the new one follows from what came before. */
function hunksOf(path: string, specs: ReadonlyArray<readonly [number, string[]]>): ReviewHunk[] {
  let shift = 0
  return specs.map(([oldStart, lines]) => {
    const hunk = hunkOf(path, oldStart, oldStart + shift, lines)
    shift += hunk.newLines - hunk.oldLines
    return hunk
  })
}

export const BACKOFF = 'src/upload/backoff.ts'
export const CLIENT = 'src/upload/client.ts'
export const CLIENT_TEST = 'src/upload/client.test.ts'

/** A new file is one hunk from the first line to the last. */
const backoffHunks = (): ReviewHunk[] => [hunkOf(BACKOFF, 0, 1, [
  '+export interface BackoffOptions {',
  '+  /** How many times to try again after the first failure. */',
  '+  retries: number',
  '+  /** The wait before the first retry; each later one doubles it. */',
  '+  baseMs: number',
  '+  /** The longest wait between two tries. */',
  '+  maxMs?: number',
  '+}',
  '+',
  '+const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))',
  '+',
  '+/** Spread retries out so that many clients that failed together do not all come back at once. */',
  '+function withJitter(ms: number): number {',
  '+  return ms * (0.5 + Math.random() / 2)',
  '+}',
  '+',
  '+/**',
  '+ * Run `task`, and run it again when it fails and `delayFor` says the failure is worth another try.',
  '+ * `delayFor` returns the wait the server asked for in milliseconds, 0 for no preference, or null to give up.',
  '+ */',
  '+export async function withBackoff<T>(',
  '+  task: () => Promise<T>,',
  '+  delayFor: (error: unknown) => number | null,',
  '+  { retries, baseMs, maxMs = 8000 }: BackoffOptions',
  '+): Promise<T> {',
  '+  for (let attempt = 0; ; attempt++) {',
  '+    try {',
  '+      return await task()',
  '+    } catch (error) {',
  '+      const requested = delayFor(error)',
  '+      if (requested === null || attempt >= retries) throw error',
  '+      const backoff = Math.min(maxMs, baseMs * 2 ** attempt)',
  '+      await sleep(Math.max(requested, withJitter(backoff)))',
  '+    }',
  '+  }',
  '+}',
  '+',
  '+/** Read a Retry-After header: seconds, or a date. Gives milliseconds, or 0 when the value says nothing usable. */',
  '+export function parseRetryAfter(value: string | null, now = Date.now()): number {',
  '+  if (!value) return 0',
  '+  const seconds = Number(value)',
  '+  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)',
  '+  const date = Date.parse(value)',
  '+  return Number.isNaN(date) ? 0 : Math.max(0, date - now)',
  '+}',
  '+',
  '+/** Which responses are worth another try: the server is busy or failing, which says nothing against the request. */',
  '+export function isRetryable(status: number): boolean {',
  '+  return status === 429 || status >= 500',
  '+}'
])]

const clientHunks = (): ReviewHunk[] => hunksOf(CLIENT, [
  [1, [
    " import { fetchWithAuth } from './auth'",
    "+import { isRetryable, parseRetryAfter, withBackoff } from './backoff'",
    " import { UploadError, type Chunk, type UploadOptions } from './types'",
    ' '
  ]],
  [9, [
    ' const CHUNK_SIZE = 5 * 1024 * 1024',
    ' const MAX_PARALLEL = 3',
    '+const MAX_RETRIES = 4',
    '+const RETRY_BASE_MS = 250',
    ' ',
    ' type Sender = (chunk: Chunk, signal?: AbortSignal) => Promise<Response>'
  ]],
  [21, [
    " /** Upload one chunk and return the server's receipt. */",
    ' export async function uploadChunk(chunk: Chunk, send: Sender = put, signal?: AbortSignal) {',
    '-  const res = await send(chunk, signal)',
    '-  if (!res.ok) throw new UploadError(res.status)',
    '-  return res.json()',
    '+  return withBackoff(async () => {',
    '+    const res = await send(chunk, signal)',
    "+    if (!res.ok) throw new UploadError(res.status, res.headers.get('retry-after'))",
    '+    return res.json()',
    '+  }, retryAfter, { retries: MAX_RETRIES, baseMs: RETRY_BASE_MS })',
    ' }',
    ' '
  ]],
  [44, [
    '   const receipts: Receipt[] = []',
    '   for (const batch of batches(chunks, MAX_PARALLEL)) {',
    '-    receipts.push(...(await Promise.all(batch.map((chunk) => uploadChunk(chunk)))))',
    '+    signal?.throwIfAborted()',
    '+    receipts.push(...(await Promise.all(batch.map((chunk) => uploadChunk(chunk, send, signal)))))',
    '     options.onProgress?.(receipts.length, chunks.length)',
    '   }'
  ]],
  [63, [
    '     options.onProgress?.(receipts.length, chunks.length)',
    '   }',
    '-  return finalize(session, receipts)',
    '+  return finalize(session, receipts, signal)',
    ' }',
    ' '
  ]],
  [78, [
    ' export async function resumeSession(id: string): Promise<Session> {',
    '-  const res = await fetchWithAuth(`/uploads/${id}`)',
    '-  if (!res.ok) throw new UploadError(res.status)',
    '-  return res.json()',
    '+  return withBackoff(async () => {',
    '+    const res = await fetchWithAuth(`/uploads/${id}`)',
    "+    if (!res.ok) throw new UploadError(res.status, res.headers.get('retry-after'))",
    '+    return res.json()',
    '+  }, retryAfter, { retries: MAX_RETRIES, baseMs: RETRY_BASE_MS })',
    ' }',
    ' '
  ]],
  [96, [
    ' async function finalize(session: Session, receipts: Receipt[], signal?: AbortSignal) {',
    "   const res = await fetchWithAuth(`/uploads/${session.id}/complete`, { method: 'POST', body: JSON.stringify({ receipts }), signal })",
    "-  if (res.status === 409) throw new UploadError(409, 'conflict')",
    '-  if (!res.ok) throw new UploadError(res.status)',
    "+  if (res.status === 409) throw new UploadError(409, null, 'The upload was changed by someone else.')",
    "+  if (!res.ok) throw new UploadError(res.status, res.headers.get('retry-after'))",
    '   return res.json()',
    ' }'
  ]],
  [118, [
    ' function batches<T>(items: T[], size: number): T[][] {',
    '   const out: T[][] = []',
    '-  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))',
    '+  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))',
    '   return out',
    ' }'
  ]],
  [133, [
    ' }',
    '+',
    '+function retryAfter(error: unknown): number | null {',
    '+  if (!(error instanceof UploadError)) return null',
    '+  if (!isRetryable(error.status)) return null',
    '+  return parseRetryAfter(error.retryAfter)',
    '+}',
    '+',
    " /** What the server returned for one finished chunk. */",
    ' interface Receipt {'
  ]],
  [150, [
    ' function describe(error: unknown): string {',
    '-  return error instanceof Error ? error.message : String(error)',
    '+  if (error instanceof UploadError) return `${error.message} (HTTP ${error.status})`',
    '+  return error instanceof Error ? error.message : String(error)',
    ' }',
    ' '
  ]],
  [171, [
    ' export function chunkSize(total: number): number {',
    '-  return total > 1_000_000_000 ? 16 * 1024 * 1024 : CHUNK_SIZE',
    '+  if (total > 1_000_000_000) return 16 * 1024 * 1024',
    '+  return CHUNK_SIZE',
    ' }',
    ' '
  ]],
  [190, [
    ' ',
    '-/** Uploads big files in chunks. */',
    '+/**',
    '+ * Uploads big files in chunks. A chunk that fails with a 429 or a 5xx is tried again with backoff,',
    "+ * and waits for as long as the server's Retry-After header asks.",
    '+ */',
    ' export class Uploader {',
    '   private readonly send: Sender',
    ' '
  ]],
  [212, [
    ' export const defaultUploader = new Uploader()',
    '+export const uploadWithRetry = defaultUploader.upload.bind(defaultUploader)',
    ' '
  ]]
])

const clientTestHunks = (): ReviewHunk[] => hunksOf(CLIENT_TEST, [
  [1, [
    "-import { describe, expect, it } from 'vitest'",
    "+import { describe, expect, it, vi } from 'vitest'",
    " import { uploadChunk } from './client'",
    "+import { UploadError } from './types'",
    ' '
  ]],
  [14, [
    ' const chunk = { index: 0, bytes: new Uint8Array(8) }',
    ' ',
    "-const reply = (status: number) => new Response('{}', { status })",
    "+const reply = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers })",
    ' ',
    " describe('uploadChunk', () => {"
  ]],
  [22, [
    ' ',
    "+  it('retries a 429 and honors Retry-After', async () => {",
    '+    vi.useFakeTimers()',
    "+    const put = vi.fn().mockResolvedValueOnce(reply(429, { 'retry-after': '2' })).mockResolvedValueOnce(reply(200))",
    '+    const done = uploadChunk(chunk, put)',
    '+    await vi.advanceTimersByTimeAsync(2000)',
    '+    await expect(done).resolves.toBeDefined()',
    '+    expect(put).toHaveBeenCalledTimes(2)',
    '+  })',
    '+',
    "+  it('gives up after four retries', async () => {",
    '+    const put = vi.fn().mockResolvedValue(reply(503))',
    '+    await expect(uploadChunk(chunk, put)).rejects.toThrow(UploadError)',
    '+    expect(put).toHaveBeenCalledTimes(5)',
    '+  })',
    '+',
    "+  it('does not retry a 400', async () => {",
    '+    const put = vi.fn().mockResolvedValue(reply(400))',
    '+    await expect(uploadChunk(chunk, put)).rejects.toThrow(UploadError)',
    '+    expect(put).toHaveBeenCalledTimes(1)',
    '+  })',
    ' })'
  ]]
])

/** A file as the preview's main process knows it: the hunks it has now, and a hash that changes whenever they do. */
export interface SeedFile {
  path: string
  status: ReviewFile['status']
  updatedAt: number
  hunks: ReviewHunk[]
  /** The hunks the file started with, which an undo puts back. */
  original: readonly ReviewHunk[]
  version: number
}

export function seedFiles(now = Date.now()): SeedFile[] {
  const file = (path: string, status: ReviewFile['status'], age: number, hunks: ReviewHunk[]): SeedFile =>
    ({ path, status, updatedAt: now - age, hunks, original: hunks.map((hunk) => ({ ...hunk })), version: 0 })
  return [
    file(BACKOFF, 'added', 52_000, backoffHunks()),
    file(CLIENT, 'modified', 40_000, clientHunks()),
    file(CLIENT_TEST, 'modified', 28_000, clientTestHunks())
  ]
}

export const headHashOf = (file: SeedFile): string => fakeDigest(`${file.path}@${file.version}`, 64)
