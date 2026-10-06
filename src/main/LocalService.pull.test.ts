import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalRuntime, PullEstimate, PullProgressUpdate } from '@local/runtimes'
import type { PullProgress } from '@shared/ipc'

vi.mock('./config', () => ({ getSettings: () => ({ local: { ollamaBaseUrl: 'http://127.0.0.1:11434' } }) }))
vi.mock('./db', () => ({ benchmarkRepo: { save: vi.fn(), list: vi.fn(() => []) } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { LocalService } from './LocalService'

const GB = 1024 ** 3
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Event = PullProgress & { pullId: string }

interface Download {
  modelId: string
  emit: (p: PullProgressUpdate) => void
  finish: () => void
  aborted: () => boolean
}

/** A runtime whose downloads stay open until the test finishes them or they are cancelled. */
function fakeRuntime(id = 'ollama', extra: Partial<LocalRuntime> = {}) {
  const downloads: Download[] = []
  const runtime: LocalRuntime = {
    id,
    name: id === 'ollama' ? 'Ollama' : id,
    detect: async () => ({ installed: true, running: true, endpoint: 'http://127.0.0.1:11434' }),
    listModels: async () => [],
    pull: (modelId, onProgress, signal) =>
      new Promise<void>((resolve) => {
        let aborted = false
        downloads.push({
          modelId,
          emit: onProgress,
          finish: () => {
            onProgress({ status: 'success', phase: 'done', done: true })
            resolve()
          },
          aborted: () => aborted
        })
        signal?.addEventListener('abort', () => {
          aborted = true
          onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
          resolve()
        })
      }),
    ...extra
  }
  return { runtime, downloads }
}

function service(runtimes: LocalRuntime[], options: { freeBytes?: (dir: string) => Promise<number>; stallAfterMs?: number } = {}) {
  const events: Event[] = []
  const local = new LocalService({} as never, (p) => events.push(p), () => undefined, { runtimes, ...options })
  const of = (pullId: string): Event[] => events.filter((e) => e.pullId === pullId)
  const last = (pullId: string): Event | undefined => of(pullId).at(-1)
  return { local, events, of, last }
}

describe('LocalService.pull: validating the request', () => {
  it.each([
    ['nothing', undefined],
    ['text', 'llama3'],
    ['an unknown runtime', { runtime: 'vllm', modelId: 'llama3' }],
    ['a runtime that is not text', { runtime: 7, modelId: 'llama3' }],
    ['no model', { runtime: 'ollama' }],
    ['an empty model', { runtime: 'ollama', modelId: '   ' }],
    ['a model name with a space', { runtime: 'ollama', modelId: 'llama 3' }],
    ['a model name that starts with a symbol', { runtime: 'ollama', modelId: '-llama' }],
    ['a model name that is not text', { runtime: 'ollama', modelId: { a: 1 } }],
    ['a model name that is far too long', { runtime: 'ollama', modelId: 'a'.repeat(500) }]
  ])('rejects %s', async (_name, req) => {
    const { runtime } = fakeRuntime()
    const { local, events } = service([runtime])
    await expect(local.pull(req)).rejects.toThrow()
    expect(events).toHaveLength(0)
  })

  it('tells the person what a model name looks like', async () => {
    const { runtime } = fakeRuntime()
    await expect(service([runtime]).local.pull({ runtime: 'ollama', modelId: 'two words' })).rejects.toThrow('Enter a model name such as llama3.1:8b.')
  })

  it('trims the name it was given', async () => {
    const { runtime, downloads } = fakeRuntime()
    await service([runtime]).local.pull({ runtime: 'ollama', modelId: '  qwen3:8b  ' })
    await tick()
    expect(downloads.map((d) => d.modelId)).toEqual(['qwen3:8b'])
  })
})

describe('LocalService.pull: one download at a time per runtime', () => {
  it('runs the first, queues the rest in order and starts each as the one before finishes', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local, of, last } = service([runtime])
    const a = (await local.pull({ runtime: 'ollama', modelId: 'a:1' })).pullId
    const b = (await local.pull({ runtime: 'ollama', modelId: 'b:1' })).pullId
    const c = (await local.pull({ runtime: 'ollama', modelId: 'c:1' })).pullId
    await tick()

    expect(downloads.map((d) => d.modelId)).toEqual(['a:1'])
    expect(of(a)[0]).toMatchObject({ phase: 'preparing', runtime: 'ollama', modelId: 'a:1' })
    expect(last(b)).toMatchObject({ phase: 'queued', queuePosition: 1, runtime: 'ollama' })
    expect(last(c)).toMatchObject({ phase: 'queued', queuePosition: 2 })

    downloads[0]!.finish()
    await tick()
    expect(downloads.map((d) => d.modelId)).toEqual(['a:1', 'b:1'])
    expect(last(a)).toMatchObject({ status: 'success', done: true })
    expect(last(b)).toMatchObject({ phase: 'preparing' })
    expect(last(c)).toMatchObject({ phase: 'queued', queuePosition: 1 })
  })

  it('gives each runtime its own line', async () => {
    const one = fakeRuntime('ollama')
    const two = fakeRuntime('mock-local')
    const { local } = service([one.runtime, two.runtime])
    await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    await local.pull({ runtime: 'mock-local', modelId: 'b:1' })
    await tick()
    expect(one.downloads).toHaveLength(1)
    expect(two.downloads).toHaveLength(1)
  })

  it('returns the download already under way instead of starting a second one', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local, events } = service([runtime])
    const first = await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    const again = await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    const queued = await local.pull({ runtime: 'ollama', modelId: 'b:1' })
    const queuedAgain = await local.pull({ runtime: 'ollama', modelId: 'b:1' })
    expect(again.pullId).toBe(first.pullId)
    expect(queuedAgain.pullId).toBe(queued.pullId)
    await tick()
    expect(downloads).toHaveLength(1)
    expect(new Set(events.map((e) => e.pullId)).size).toBe(2)
  })

  it('allows the same model again once its download has ended', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local } = service([runtime])
    const first = await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    await tick()
    downloads[0]!.finish()
    await tick()
    const second = await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    expect(second.pullId).not.toBe(first.pullId)
    await tick()
    expect(downloads).toHaveLength(2)
  })
})

describe('LocalService.cancelPull', () => {
  it('cancels a download that is waiting without ever starting it, and renumbers the line', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local, last } = service([runtime])
    await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    const b = (await local.pull({ runtime: 'ollama', modelId: 'b:1' })).pullId
    const c = (await local.pull({ runtime: 'ollama', modelId: 'c:1' })).pullId
    await tick()
    local.cancelPull(b)
    expect(last(b)).toMatchObject({ status: 'cancelled', phase: 'cancelled', done: true })
    expect(last(c)).toMatchObject({ phase: 'queued', queuePosition: 1 })
    downloads[0]!.finish()
    await tick()
    expect(downloads.map((d) => d.modelId)).toEqual(['a:1', 'c:1'])
  })

  it('cancels the running download, tells the runtime and starts the next', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local, last } = service([runtime])
    const a = (await local.pull({ runtime: 'ollama', modelId: 'a:1' })).pullId
    await local.pull({ runtime: 'ollama', modelId: 'b:1' })
    await tick()
    local.cancelPull(a)
    await tick()
    expect(downloads[0]!.aborted()).toBe(true)
    expect(last(a)).toMatchObject({ status: 'cancelled', done: true })
    expect(downloads.map((d) => d.modelId)).toEqual(['a:1', 'b:1'])
  })

  it('ignores an id it does not know, or one that is not text', () => {
    const { runtime } = fakeRuntime()
    const { local } = service([runtime])
    expect(() => local.cancelPull('nope')).not.toThrow()
    expect(() => local.cancelPull(42 as unknown as string)).not.toThrow()
  })
})

describe('LocalService.pull: failing fast with the fix', () => {
  it('says Ollama is not running, in one event, without queueing behind anything else', async () => {
    const { runtime, downloads } = fakeRuntime('ollama', {
      detect: async () => ({ installed: false, running: false, endpoint: 'http://127.0.0.1:11434', error: 'Ollama not reachable' })
    })
    const { local, last, of } = service([runtime])
    const { pullId } = await local.pull({ runtime: 'ollama', modelId: 'llama3.1:8b' })
    await tick()
    expect(last(pullId)).toMatchObject({
      status: 'error',
      errorCode: 'runtime_unreachable',
      done: true,
      error: 'Could not reach Ollama at http://127.0.0.1:11434. Make sure Ollama is running, then try again.'
    })
    expect(of(pullId).filter((e) => e.done)).toHaveLength(1)
    expect(downloads).toHaveLength(0)
  })

  it('lets the same model be asked for again after a failure', async () => {
    let up = false
    const { runtime, downloads } = fakeRuntime('ollama', { detect: async () => ({ installed: true, running: up }) })
    const { local, last } = service([runtime])
    const failed = (await local.pull({ runtime: 'ollama', modelId: 'a:1' })).pullId
    await tick()
    expect(last(failed)).toMatchObject({ status: 'error' })
    up = true
    const retry = (await local.pull({ runtime: 'ollama', modelId: 'a:1' })).pullId
    await tick()
    expect(retry).not.toBe(failed)
    expect(downloads).toHaveLength(1)
  })

  it('refuses a model that does not fit on the disk before downloading anything', async () => {
    const estimate: PullEstimate = { totalBytes: 4.9 * GB, remainingBytes: 4.9 * GB, source: 'registry' }
    const { runtime, downloads } = fakeRuntime('ollama', {
      estimatePull: async () => estimate,
      modelsDir: () => 'C:\\Users\\a\\.ollama\\models',
      diskAdvice: 'Free up space.'
    })
    const { local, last } = service([runtime], { freeBytes: async () => 2.1 * GB })
    const { pullId } = await local.pull({ runtime: 'ollama', modelId: 'llama3.1:8b' })
    await vi.waitFor(() => expect(last(pullId)).toMatchObject({ done: true }))
    const event = last(pullId)!
    expect(event).toMatchObject({ status: 'error', phase: 'error', errorCode: 'disk_space', done: true })
    expect(event.error).toContain('This model needs about 4.9 GB and ')
    expect(event.error).toContain('has 2.1 GB free')
    expect(event.error).toContain('Free up space.')
    expect(downloads).toHaveLength(0)
  })

  it('uses the built-in catalog size for a model the runtime cannot size', async () => {
    const { runtime, downloads } = fakeRuntime('ollama', { modelsDir: () => '/models' })
    const { local, last } = service([runtime], { freeBytes: async () => 1 * GB })
    const { pullId } = await local.pull({ runtime: 'ollama', modelId: 'llama3.1:8b' })
    await vi.waitFor(() => expect(last(pullId)).toMatchObject({ errorCode: 'disk_space' }))
    expect(downloads).toHaveLength(0)
  })

  it('goes ahead for a model nothing can size', async () => {
    const { runtime, downloads } = fakeRuntime('ollama', { modelsDir: () => '/models' })
    const { local } = service([runtime], { freeBytes: async () => 1 * GB })
    await local.pull({ runtime: 'ollama', modelId: 'someone/unlisted-model:1b' })
    await vi.waitFor(() => expect(downloads).toHaveLength(1))
  })
})

describe('LocalService.pull: a download that stops receiving bytes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is reported as stalled, and the report clears when bytes return', async () => {
    const { runtime, downloads } = fakeRuntime()
    const { local, events } = service([runtime], { stallAfterMs: 30_000 })
    const { pullId } = await local.pull({ runtime: 'ollama', modelId: 'a:1' })
    await vi.advanceTimersByTimeAsync(0)
    downloads[0]!.emit({ status: 'downloading', phase: 'downloading', completedBytes: 1000, totalBytes: 9000, speedBps: 500, done: false })
    await vi.advanceTimersByTimeAsync(40_000)
    const stalled = events.filter((e) => e.pullId === pullId && e.stalledForSeconds !== undefined).at(-1)!
    expect(stalled.stalledForSeconds).toBeGreaterThanOrEqual(30)
    expect(stalled.speedBps).toBeUndefined()

    downloads[0]!.emit({ status: 'downloading', phase: 'downloading', completedBytes: 2000, totalBytes: 9000, speedBps: 500, done: false })
    await vi.advanceTimersByTimeAsync(300)
    expect(events.filter((e) => e.pullId === pullId).at(-1)).toMatchObject({ completedBytes: 2000 })
    expect(events.filter((e) => e.pullId === pullId).at(-1)!.stalledForSeconds).toBeUndefined()
  })
})
