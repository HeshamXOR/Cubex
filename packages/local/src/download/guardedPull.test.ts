import { describe, expect, it, vi } from 'vitest'
import type { LocalRuntime, PullEstimate, PullProgressUpdate, RuntimeDetection } from '../runtimes/LocalRuntime'
import { runGuardedPull, type GuardedPullOptions } from './guardedPull'

const GB = 1024 ** 3

interface Fake {
  runtime: LocalRuntime
  pull: ReturnType<typeof vi.fn>
}

function fakeRuntime(parts: {
  detect?: () => Promise<RuntimeDetection>
  estimate?: PullEstimate | undefined
  dir?: string | undefined
  pull?: (modelId: string, onProgress: (p: PullProgressUpdate) => void, signal?: AbortSignal) => Promise<void>
  noPull?: boolean
}): Fake {
  const pull = vi.fn(parts.pull ?? (async (_id: string, onProgress: (p: PullProgressUpdate) => void) => onProgress({ status: 'success', phase: 'done', done: true })))
  const runtime: LocalRuntime = {
    id: 'ollama',
    name: 'Ollama',
    detect: parts.detect ?? (async () => ({ installed: true, running: true, endpoint: 'http://127.0.0.1:11434' })),
    listModels: async () => [],
    ...(parts.noPull ? {} : { pull }),
    diskAdvice: 'Use a bigger drive.',
    estimatePull: async () => parts.estimate,
    modelsDir: () => ('dir' in parts ? parts.dir : '/models')
  }
  return { runtime, pull }
}

async function run(fake: Fake, extra: Partial<GuardedPullOptions> = {}, signal: AbortSignal = new AbortController().signal): Promise<PullProgressUpdate[]> {
  const updates: PullProgressUpdate[] = []
  await runGuardedPull({ runtime: fake.runtime, modelId: 'llama3.1:8b', freeBytes: async () => 100 * GB, ...extra }, (p) => updates.push(p), signal)
  return updates
}

const terminal = (updates: PullProgressUpdate[]): PullProgressUpdate | undefined => updates.filter((u) => u.done).at(-1)

describe('runGuardedPull: the runtime must answer', () => {
  it('fails at once, with the fix, when the runtime is not running', async () => {
    const fake = fakeRuntime({ detect: async () => ({ installed: false, running: false, endpoint: 'http://127.0.0.1:11434', error: 'Ollama not reachable' }) })
    const updates = await run(fake)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'error',
      phase: 'error',
      errorCode: 'runtime_unreachable',
      done: true,
      error: 'Could not reach Ollama at http://127.0.0.1:11434. Make sure Ollama is running, then try again.'
    })
    expect(fake.pull).not.toHaveBeenCalled()
  })

  it('says to restart a runtime that answers with an error status', async () => {
    const fake = fakeRuntime({ detect: async () => ({ installed: true, running: false, endpoint: 'http://127.0.0.1:11434', error: 'HTTP 500' }) })
    expect(terminal(await run(fake))?.error).toBe('Ollama answered HTTP 500 at http://127.0.0.1:11434. Restart Ollama, then try again.')
  })

  it('treats a detection that throws as unreachable', async () => {
    const fake = fakeRuntime({
      detect: async () => {
        throw new Error('boom')
      }
    })
    expect(terminal(await run(fake))).toMatchObject({ errorCode: 'runtime_unreachable' })
  })

  it('refuses a runtime that cannot download', async () => {
    const updates = await run(fakeRuntime({ noPull: true }))
    expect(terminal(updates)).toMatchObject({ errorCode: 'unsupported', error: expect.stringContaining('cannot download models') })
  })
})

describe('runGuardedPull: the disk is checked before the first byte', () => {
  it('refuses a model the disk cannot hold and never starts the download', async () => {
    const fake = fakeRuntime({ estimate: { totalBytes: 4.9 * GB, remainingBytes: 4.9 * GB, source: 'registry' } })
    const updates = await run(fake, { freeBytes: async () => 2.1 * GB, platform: 'win32' })
    const last = terminal(updates)!
    expect(last).toMatchObject({ status: 'error', errorCode: 'disk_space', done: true })
    expect(last.error).toContain('This model needs about 4.9 GB and ')
    expect(last.error).toContain('has 2.1 GB free')
    expect(last.error).toContain('Use a bigger drive.')
    expect(fake.pull).not.toHaveBeenCalled()
  })

  it('checks what is still missing, not the whole model', async () => {
    const fake = fakeRuntime({ estimate: { totalBytes: 10 * GB, remainingBytes: 1 * GB, source: 'registry' } })
    const updates = await run(fake, { freeBytes: async () => 3 * GB })
    expect(terminal(updates)).toMatchObject({ status: 'success' })
    expect(fake.pull).toHaveBeenCalledOnce()
  })

  it('falls back to the catalog size for a model the runtime cannot size', async () => {
    const fake = fakeRuntime({ estimate: undefined })
    const updates = await run(fake, { catalogBytes: (id) => (id === 'llama3.1:8b' ? 4.7 * GB : undefined), freeBytes: async () => 1 * GB })
    expect(terminal(updates)).toMatchObject({ errorCode: 'disk_space' })
    expect(fake.pull).not.toHaveBeenCalled()
  })

  it('goes ahead when nothing can size the model', async () => {
    const fake = fakeRuntime({ estimate: undefined })
    const updates = await run(fake, { freeBytes: async () => 1 })
    expect(terminal(updates)).toMatchObject({ status: 'success' })
  })

  it('does not check a disk it cannot see, such as a runtime on another machine', async () => {
    const fake = fakeRuntime({ dir: undefined, estimate: { totalBytes: 500 * GB, remainingBytes: 500 * GB, source: 'registry' } })
    const updates = await run(fake, { freeBytes: async () => 1 })
    expect(terminal(updates)).toMatchObject({ status: 'success' })
  })

  it('never refuses because the free space could not be measured', async () => {
    const fake = fakeRuntime({ estimate: { totalBytes: 500 * GB, remainingBytes: 500 * GB, source: 'registry' } })
    const updates = await run(fake, { freeBytes: async () => Number.POSITIVE_INFINITY })
    expect(terminal(updates)).toMatchObject({ status: 'success' })
  })
})

describe('runGuardedPull: the disk is checked again as the model is revealed', () => {
  const downloading = (completed: number, total: number): PullProgressUpdate => ({ status: 'downloading', phase: 'downloading', completedBytes: completed, totalBytes: total, done: false })

  /** A runtime that announces a total, then waits until it is aborted, as a long download does. */
  const slowRuntime = (total: number, aborted: { value: boolean }) =>
    fakeRuntime({
      pull: (_id, onProgress, signal) =>
        new Promise<void>((resolve) => {
          onProgress(downloading(1 * GB, total))
          signal?.addEventListener('abort', () => {
            aborted.value = true
            onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
            resolve()
          })
        })
    })

  it('stops a download that will not fit and reports the disk, not a cancellation', async () => {
    const aborted = { value: false }
    const updates = await run(slowRuntime(6 * GB, aborted), { freeBytes: async () => 2 * GB })
    expect(aborted.value).toBe(true)
    const last = terminal(updates)!
    expect(last).toMatchObject({ status: 'error', errorCode: 'disk_space' })
    expect(last.error).toContain('needs about 5.0 GB')
    expect(updates.filter((u) => u.done)).toHaveLength(1)
  })

  it('reports the disk even when the runtime stops without saying so', async () => {
    const fake = fakeRuntime({
      pull: (_id, onProgress, signal) =>
        new Promise<void>((resolve) => {
          onProgress(downloading(0, 8 * GB))
          signal?.addEventListener('abort', () => resolve())
        })
    })
    const updates = await run(fake, { freeBytes: async () => 2 * GB })
    expect(terminal(updates)).toMatchObject({ errorCode: 'disk_space' })
  })

  it('lets a download that fits run to the end', async () => {
    const fake = fakeRuntime({
      pull: async (_id, onProgress) => {
        onProgress(downloading(0, 4 * GB))
        onProgress(downloading(2 * GB, 4 * GB))
        onProgress({ status: 'success', phase: 'done', done: true })
      }
    })
    const updates = await run(fake, { freeBytes: async () => 50 * GB })
    expect(terminal(updates)).toMatchObject({ status: 'success' })
    expect(updates.filter((u) => u.status === 'downloading')).toHaveLength(2)
  })

  it('checks again when a later layer reveals more of the model', async () => {
    const free = vi.fn(async () => 5 * GB)
    const fake = fakeRuntime({
      pull: (_id, onProgress, signal) =>
        new Promise<void>((resolve) => {
          onProgress(downloading(0, 2 * GB))
          setTimeout(() => onProgress(downloading(2 * GB, 9 * GB)), 5)
          signal?.addEventListener('abort', () => {
            onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
            resolve()
          })
        })
    })
    const updates = await run(fake, { freeBytes: free })
    expect(terminal(updates)).toMatchObject({ errorCode: 'disk_space' })
    expect(free.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('runGuardedPull: cancelling', () => {
  it('reports a cancellation without starting when the person cancels while the runtime is checked', async () => {
    const controller = new AbortController()
    const fake = fakeRuntime({
      detect: async () => {
        controller.abort()
        return { installed: true, running: true }
      }
    })
    const updates = await run(fake, {}, controller.signal)
    expect(terminal(updates)).toMatchObject({ status: 'cancelled', phase: 'cancelled' })
    expect(fake.pull).not.toHaveBeenCalled()
  })

  it('passes a cancellation on to the runtime and reports it as one', async () => {
    const controller = new AbortController()
    let sawAbort = false
    const fake = fakeRuntime({
      pull: (_id, onProgress, signal) =>
        new Promise<void>((resolve) => {
          onProgress({ status: 'downloading', phase: 'downloading', completedBytes: 1, totalBytes: 10, done: false })
          signal?.addEventListener('abort', () => {
            sawAbort = true
            onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
            resolve()
          })
          setTimeout(() => controller.abort(), 5)
        })
    })
    const updates = await run(fake, {}, controller.signal)
    expect(sawAbort).toBe(true)
    expect(terminal(updates)).toMatchObject({ status: 'cancelled' })
  })
})
