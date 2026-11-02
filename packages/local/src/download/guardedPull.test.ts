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
})

describe('runGuardedPull: cancelling', () => {

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
