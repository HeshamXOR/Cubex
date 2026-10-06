import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullManager, type PullEvent, type PullTask } from './PullManager'
import type { PullProgressUpdate } from '../runtimes/LocalRuntime'

/** A task the test controls: it settles only when `finish()` or `fail()` is called, or when aborted. */
function controllable(pullId: string) {
  let finish!: () => void
  let fail!: (e: Error) => void
  let emit!: (p: PullProgressUpdate) => void
  let aborted = false
  const task: PullTask = {
    pullId,
    modelId: `model-${pullId}`,
    run: (onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        emit = onProgress
        finish = () => {
          onProgress({ status: 'success', done: true })
          resolve()
        }
        fail = reject
        signal.addEventListener('abort', () => {
          aborted = true
          onProgress({ status: 'cancelled', done: true })
          resolve()
        })
      })
  }
  return { task, finish: () => finish(), fail: (e: Error) => fail(e), emit: (p: PullProgressUpdate) => emit(p), wasAborted: () => aborted }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('PullManager', () => {
  it('runs at most maxConcurrent pulls and starts queued ones as slots free up', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ maxConcurrent: 2, onEvent: (e) => events.push(e) })
    const a = controllable('a')
    const b = controllable('b')
    const c = controllable('c')
    pm.enqueue(a.task)
    pm.enqueue(b.task)
    pm.enqueue(c.task)
    await tick()
    expect(pm.runningCount).toBe(2)
    expect(pm.queuedCount).toBe(1)
    const queued = events.find((e) => e.pullId === 'c')
    expect(queued).toMatchObject({ status: 'queued', phase: 'queued', done: false, queuePosition: 1 })

    a.finish()
    await tick()
    expect(pm.runningCount).toBe(2) // c took the slot
    expect(pm.queuedCount).toBe(0)
    b.finish()
    c.finish()
    await tick()
    expect(pm.runningCount).toBe(0)
  })

  it('delivers exactly one terminal event per pull', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ onEvent: (e) => events.push(e) })
    const a = controllable('a')
    pm.enqueue(a.task)
    await tick()
    a.finish()
    await tick()
    expect(events.filter((e) => e.pullId === 'a' && e.done)).toHaveLength(1)
  })

  it('reports a rejected task as an error event with the message', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ onEvent: (e) => events.push(e) })
    const a = controllable('a')
    pm.enqueue(a.task)
    await tick()
    a.fail(new Error('disk exploded'))
    await tick()
    expect(events.at(-1)).toMatchObject({ pullId: 'a', status: 'error', done: true, error: 'disk exploded' })
  })

  it('synthesizes a success event when a task resolves without a terminal event', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ onEvent: (e) => events.push(e) })
    pm.enqueue({ pullId: 'q', modelId: 'm', run: async () => undefined })
    await tick()
    expect(events.at(-1)).toMatchObject({ pullId: 'q', status: 'success', done: true })
  })

  it('cancels a queued pull without ever running it', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ maxConcurrent: 1, onEvent: (e) => events.push(e) })
    const a = controllable('a')
    let ranB = false
    pm.enqueue(a.task)
    pm.enqueue({ pullId: 'b', modelId: 'mb', run: async () => { ranB = true } })
    await tick()
    expect(pm.cancel('b')).toBe(true)
    expect(events.at(-1)).toMatchObject({ pullId: 'b', status: 'cancelled', done: true })
    a.finish()
    await tick()
    expect(ranB).toBe(false)
    expect(pm.queuedCount).toBe(0)
  })

  it('cancels a running pull by aborting its signal and frees the slot', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ maxConcurrent: 1, onEvent: (e) => events.push(e) })
    const a = controllable('a')
    const b = controllable('b')
    pm.enqueue(a.task)
    pm.enqueue(b.task)
    await tick()
    expect(pm.cancel('a')).toBe(true)
    await tick()
    expect(a.wasAborted()).toBe(true)
    expect(events.filter((e) => e.pullId === 'a' && e.done).map((e) => e.status)).toEqual(['cancelled'])
    expect(pm.runningCount).toBe(1) // b started
    expect(pm.cancel('does-not-exist')).toBe(false)
  })

  it('reports a cancelled event when a cancelled task rejects instead of resolving', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ onEvent: (e) => events.push(e) })
    pm.enqueue({
      pullId: 'r',
      modelId: 'm',
      run: (_p, signal) => new Promise<void>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('AbortError'))))
    })
    await tick()
    pm.cancel('r')
    await tick()
    expect(events.at(-1)).toMatchObject({ pullId: 'r', status: 'cancelled', done: true })
    expect(events.at(-1)?.error).toBeUndefined()
  })

  it('throttles progress per pull but never drops the terminal event', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ minProgressIntervalMs: 1000, onEvent: (e) => events.push(e) })
    const a = controllable('a')
    pm.enqueue(a.task)
    await tick()
    for (let i = 1; i <= 50; i++) a.emit({ status: 'downloading', completedBytes: i, totalBytes: 50, done: false })
    a.finish()
    await tick()
    const progress = events.filter((e) => e.pullId === 'a' && !e.done && e.status === 'downloading')
    expect(progress.length).toBeLessThanOrEqual(2)
    expect(events.at(-1)).toMatchObject({ status: 'success', done: true })
  })
})

describe('PullManager queue hand-off', () => {
  it('moves a queued pull to preparing the moment it gets the slot, and renumbers the rest', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ maxConcurrent: 1, onEvent: (e) => events.push(e) })
    const a = controllable('a')
    const b = controllable('b')
    const c = controllable('c')
    pm.enqueue(a.task)
    pm.enqueue(b.task)
    pm.enqueue(c.task)
    await tick()
    const phases = (id: string): Array<string | undefined> => events.filter((e) => e.pullId === id).map((e) => `${e.phase}${e.queuePosition ?? ''}`)
    expect(phases('a')[0]).toBe('preparing')
    expect(phases('b')).toEqual(['queued1', 'queued1'])
    expect(phases('c')).toEqual(['queued2'])

    a.finish()
    await tick()
    expect(phases('b').at(-1)).toBe('preparing')
    expect(events.filter((e) => e.pullId === 'c').at(-1)).toMatchObject({ phase: 'queued', queuePosition: 1 })
  })

  it('renumbers the line when a queued pull is cancelled', async () => {
    const events: PullEvent[] = []
    const pm = new PullManager({ maxConcurrent: 1, onEvent: (e) => events.push(e) })
    pm.enqueue(controllable('a').task)
    pm.enqueue(controllable('b').task)
    pm.enqueue(controllable('c').task)
    await tick()
    pm.cancel('b')
    expect(events.filter((e) => e.pullId === 'c').at(-1)).toMatchObject({ phase: 'queued', queuePosition: 1 })
  })
})

describe('PullManager stall watch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const stalledPull = async (options: { stallAfterMs?: number } = {}) => {
    vi.useFakeTimers()
    const events: PullEvent[] = []
    const pm = new PullManager({ stallAfterMs: 30_000, stallCheckMs: 1000, minProgressIntervalMs: 0, onEvent: (e) => events.push(e), ...options })
    const a = controllable('a')
    pm.enqueue(a.task)
    await vi.advanceTimersByTimeAsync(0)
    return { events, a }
  }
  const stalledEvents = (events: PullEvent[]): PullEvent[] => events.filter((e) => e.stalledForSeconds !== undefined)

  it('flags a download that stops receiving bytes, without the stale speed and ETA', async () => {
    const { events, a } = await stalledPull()
    a.emit({ status: 'downloading', phase: 'downloading', completedBytes: 1000, totalBytes: 5000, speedBps: 400, etaSeconds: 10, done: false })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(stalledEvents(events)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2000)
    const flagged = stalledEvents(events).at(-1)!
    expect(flagged).toMatchObject({ pullId: 'a', phase: 'downloading', completedBytes: 1000, totalBytes: 5000 })
    expect(flagged.stalledForSeconds).toBeGreaterThanOrEqual(30)
    expect(flagged.speedBps).toBeUndefined()
    expect(flagged.etaSeconds).toBeUndefined()
  })

  it('clears the flag as soon as new bytes arrive', async () => {
    const { events, a } = await stalledPull()
    a.emit({ status: 'downloading', phase: 'downloading', completedBytes: 1000, totalBytes: 5000, done: false })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(stalledEvents(events).length).toBeGreaterThan(0)

    a.emit({ status: 'downloading', phase: 'downloading', completedBytes: 1500, totalBytes: 5000, done: false })
    expect(events.at(-1)).toMatchObject({ completedBytes: 1500 })
    expect(events.at(-1)!.stalledForSeconds).toBeUndefined()
    const flaggedBefore = stalledEvents(events).length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(stalledEvents(events)).toHaveLength(flaggedBefore)
  })

  it('does not count a repeated status with the same bytes as progress', async () => {
    const { events, a } = await stalledPull()
    for (let i = 0; i < 6; i++) {
      a.emit({ status: 'downloading', phase: 'downloading', completedBytes: 1000, totalBytes: 5000, done: false })
      await vi.advanceTimersByTimeAsync(6000)
    }
    expect(stalledEvents(events).length).toBeGreaterThan(0)
  })

  it('does not flag quiet verifying or finishing stages, which can be slow without being stuck', async () => {
    const { events, a } = await stalledPull()
    a.emit({ status: 'verifying', phase: 'verifying', done: false })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stalledEvents(events)).toHaveLength(0)
  })

  it('flags a model lookup that never answers', async () => {
    const { events } = await stalledPull()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(stalledEvents(events).at(-1)).toMatchObject({ phase: 'preparing' })
  })

  it('stops watching once the pull ends', async () => {
    const { events, a } = await stalledPull()
    a.finish()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stalledEvents(events)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can be turned off', async () => {
    const { events } = await stalledPull({ stallAfterMs: 0 })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(stalledEvents(events)).toHaveLength(0)
  })
})
