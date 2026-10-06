import { describe, expect, it } from 'vitest'
import { applyPullEvent, failedPull, pullKey, sortPulls, startingPull, type Pull, type PullsSnapshot } from './pullModel'

const empty: PullsSnapshot = { pulls: {}, finished: 0 }
const event = (modelId: string, extra: Partial<Pull> = {}): Pull => ({ pullId: `id-${modelId}`, modelId, runtime: 'ollama', status: 'downloading', done: false, ...extra })

describe('pullKey', () => {
  it('is one per model per runtime, and assumes Ollama when no runtime is named', () => {
    expect(pullKey({ modelId: 'a:1' })).toBe(pullKey({ runtime: 'ollama', modelId: 'a:1' }))
    expect(pullKey({ runtime: 'mock-local', modelId: 'a:1' })).not.toBe(pullKey({ runtime: 'ollama', modelId: 'a:1' }))
  })
})

describe('applyPullEvent', () => {
  it('adds a download and replaces it as it moves on', () => {
    const queued = applyPullEvent(empty, event('a:1', { phase: 'queued', queuePosition: 2, status: 'queued' }))
    const running = applyPullEvent(queued, event('a:1', { phase: 'downloading', completedBytes: 5, totalBytes: 10 }))
    expect(Object.values(running.pulls)).toHaveLength(1)
    expect(Object.values(running.pulls)[0]).toMatchObject({ phase: 'downloading', completedBytes: 5 })
  })

  it('replaces the row shown the instant the person asked, once the real events come in', () => {
    const asked = { pulls: { [pullKey({ modelId: 'a:1' })]: startingPull('ollama', 'a:1') }, finished: 0 }
    const next = applyPullEvent(asked, event('a:1', { phase: 'preparing', status: 'pulling manifest' }))
    expect(Object.values(next.pulls)[0]!.pullId).toBe('id-a:1')
  })

  it('drops a finished download and counts it, so a view knows to refetch what is installed', () => {
    const running = applyPullEvent(empty, event('a:1'))
    const done = applyPullEvent(running, event('a:1', { status: 'success', phase: 'done', done: true }))
    expect(done.pulls).toEqual({})
    expect(done.finished).toBe(1)
  })

  it('drops a cancelled download without counting it', () => {
    const running = applyPullEvent(empty, event('a:1'))
    const cancelled = applyPullEvent(running, event('a:1', { status: 'cancelled', phase: 'cancelled', done: true }))
    expect(cancelled.pulls).toEqual({})
    expect(cancelled.finished).toBe(0)
  })

  it('keeps a failed download, with its reason, until it is dismissed', () => {
    const running = applyPullEvent(empty, event('a:1'))
    const failed = applyPullEvent(running, event('a:1', { status: 'error', phase: 'error', done: true, error: 'Disk is full.' }))
    expect(Object.values(failed.pulls)[0]).toMatchObject({ error: 'Disk is full.' })
    expect(failed.finished).toBe(0)
  })

  it('leaves other downloads alone', () => {
    const both = applyPullEvent(applyPullEvent(empty, event('a:1')), event('b:1'))
    const oneDone = applyPullEvent(both, event('a:1', { status: 'success', done: true }))
    expect(Object.values(oneDone.pulls).map((p) => p.modelId)).toEqual(['b:1'])
  })

  it('does not mutate the list it was given', () => {
    const before = applyPullEvent(empty, event('a:1'))
    const frozen = JSON.stringify(before)
    applyPullEvent(before, event('a:1', { done: true, status: 'success' }))
    expect(JSON.stringify(before)).toBe(frozen)
  })
})

describe('sortPulls', () => {
  it('puts the running download first, then those waiting in order, then failures', () => {
    const pulls: Record<string, Pull> = {}
    for (const p of [
      event('failed:1', { done: true, status: 'error', error: 'x', phase: 'error' }),
      event('third:1', { phase: 'queued', queuePosition: 2 }),
      event('second:1', { phase: 'queued', queuePosition: 1 }),
      event('running:1', { phase: 'downloading' })
    ]) pulls[pullKey(p)] = p
    expect(sortPulls(pulls).map((p) => p.modelId)).toEqual(['running:1', 'second:1', 'third:1', 'failed:1'])
  })
})

describe('the rows the person sees at once', () => {
  it('starts as a download being prepared, with no id yet', () => {
    expect(startingPull('ollama', 'a:1')).toMatchObject({ pullId: '', phase: 'preparing', done: false })
  })

  it('shows a failure to ask as a failed download', () => {
    expect(failedPull('ollama', 'a:1', 'No.')).toMatchObject({ phase: 'error', done: true, error: 'No.' })
  })
})
