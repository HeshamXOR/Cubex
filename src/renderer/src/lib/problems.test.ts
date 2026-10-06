import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticItem } from '../../../shared/ipc'

const getDiagnostics = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api: { getDiagnostics } }))

import { fetchProblems, loadProblems, resetProblemCache } from './problems'

const problem = (over: Partial<DiagnosticItem> = {}): DiagnosticItem => ({ path: 'src/a.ts', line: 1, col: 1, code: 'TS2322', message: 'boom', ...over })

beforeEach(() => {
  getDiagnostics.mockReset()
  getDiagnostics.mockResolvedValue([])
  resetProblemCache()
  vi.useRealTimers()
})

describe('fetchProblems', () => {
  it('asks once per version and shares the answer', async () => {
    getDiagnostics.mockResolvedValue([problem()])
    const [first, second] = await Promise.all([fetchProblems('c1', 'src/a.ts', 1), fetchProblems('c1', 'src/a.ts', 1)])
    expect(first).toEqual([problem()])
    expect(second).toBe(first)
    expect(await fetchProblems('c1', 'src/a.ts', 1)).toEqual([problem()])
    expect(getDiagnostics).toHaveBeenCalledTimes(1)
    expect(getDiagnostics).toHaveBeenCalledWith('c1', 'src/a.ts')
  })

  it('asks again after an edit, which is a new version of the file', async () => {
    getDiagnostics.mockResolvedValueOnce([problem()]).mockResolvedValueOnce([])
    expect(await fetchProblems('c1', 'src/a.ts', 1)).toHaveLength(1)
    expect(await fetchProblems('c1', 'src/a.ts', 2)).toHaveLength(0)
    expect(getDiagnostics).toHaveBeenCalledTimes(2)
  })

  it('keeps tasks and files apart', async () => {
    await fetchProblems('c1', 'src/a.ts', 1)
    await fetchProblems('c2', 'src/a.ts', 1)
    await fetchProblems('c1', 'src/b.ts', 1)
    await fetchProblems('c1', undefined, 1)
    expect(getDiagnostics.mock.calls).toEqual([['c1', 'src/a.ts'], ['c2', 'src/a.ts'], ['c1', 'src/b.ts'], ['c1', undefined]])
  })

  it('does not trust a clean answer for long, because an unfinished check answers the same way', async () => {
    vi.useFakeTimers()
    await fetchProblems('c1', 'src/a.ts', 1)
    await fetchProblems('c1', 'src/a.ts', 1)
    expect(getDiagnostics).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(21_000)
    await fetchProblems('c1', 'src/a.ts', 1)
    expect(getDiagnostics).toHaveBeenCalledTimes(2)
  })

  it('turns a failing call into an empty list', async () => {
    getDiagnostics.mockRejectedValue(new Error('no handler registered'))
    expect(await fetchProblems('c1', 'src/a.ts', 1)).toEqual([])
  })

  it('asks one question at a time, in the order they were asked', async () => {
    const order: string[] = []
    let release!: () => void
    getDiagnostics.mockImplementationOnce(() => new Promise((resolve) => { order.push('start a'); release = () => { order.push('end a'); resolve([]) } }))
    getDiagnostics.mockImplementationOnce(async () => { order.push('start b'); return [] })
    const a = fetchProblems('c1', 'src/a.ts', 1)
    const b = fetchProblems('c1', 'src/b.ts', 1)
    await Promise.resolve()
    expect(order).toEqual(['start a'])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['start a', 'end a', 'start b'])
  })
})

describe('loadProblems', () => {
  it('goes to the checker every time and lets a failure through to the caller', async () => {
    getDiagnostics.mockResolvedValueOnce([problem()]).mockRejectedValueOnce(new Error('no handler registered'))
    expect(await loadProblems('c1', 'src/a.ts')).toHaveLength(1)
    await expect(loadProblems('c1', 'src/a.ts')).rejects.toThrow('no handler registered')
    expect(getDiagnostics).toHaveBeenCalledTimes(2)
  })
})
