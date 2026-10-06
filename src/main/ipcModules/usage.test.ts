import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  groups: vi.fn((_since: number) => [] as unknown[])
}))
vi.mock('../config', () => ({ getSettings: () => mocks.settings }))
vi.mock('../db', () => ({ usageRepo: { breakdownSince: (since: number) => mocks.groups(since) } }))

import { register } from './usage'

let handlers: Map<string, (...args: unknown[]) => unknown>
const snapshot = vi.fn((_task?: string) => ({ daily: 1.5 }) as { turn?: number; session?: number; daily: number })
const taskIdArg = vi.fn((value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Invalid task id.')
  return value
})
const call = (...args: unknown[]) => handlers.get(IPC.getUsageReport)!(...args) as { today: { costUsd: number }; budget: { action: string; meters: Array<{ scope: string }> } }

beforeEach(() => {
  handlers = new Map()
  mocks.settings = { ai: { budget: { dailyUsd: 2, perSessionUsd: 5, action: 'stop' } } }
  mocks.groups.mockReset().mockReturnValue([])
  snapshot.mockReset().mockReturnValue({ daily: 1.5 })
  taskIdArg.mockClear()
  register({
    handle: (channel: string, fn: (...args: never[]) => unknown) => { handlers.set(channel, fn as (...args: unknown[]) => unknown) },
    chat: { budgetSnapshot: snapshot },
    taskIdArg
  } as never)
})

describe('usage:report', () => {
  it('declares only its own channel while registering', () => {
    expect([...handlers.keys()]).toEqual([IPC.getUsageReport])
  })

  it('reports the day against the caps, with no session meter when no task is given', () => {
    mocks.groups.mockReturnValue([{ providerId: 'p', model: 'm', execution: 'cloud', costSource: 'catalog', requests: 3, cost: 1.5, tokens: 900 }])
    const report = call()
    expect(report.today.costUsd).toBe(1.5)
    expect(report.budget.action).toBe('stop')
    expect(report.budget.meters.map((meter) => meter.scope)).toEqual(['daily'])
    expect(snapshot).toHaveBeenCalledWith(undefined)
    expect(taskIdArg).not.toHaveBeenCalled()
  })

  it('adds the session meter for a task, after checking the id the window sent', () => {
    snapshot.mockReturnValue({ daily: 1.5, session: 4.5 })
    const report = call('task-1')
    expect(taskIdArg).toHaveBeenCalledWith('task-1')
    expect(snapshot).toHaveBeenCalledWith('task-1')
    expect(report.budget.meters.map((meter) => meter.scope)).toEqual(['daily', 'session'])
  })

  it('treats a null task like none', () => {
    call(null)
    expect(snapshot).toHaveBeenCalledWith(undefined)
  })

  it.each([42, {}, [], '', 'x'.repeat(500)])('rejects a task id that is not a bounded string without reading anything: %j', (bad) => {
    expect(() => call(bad)).toThrow()
    expect(snapshot).not.toHaveBeenCalled()
    expect(mocks.groups).not.toHaveBeenCalled()
  })

  it('reads the caps from Settings on every call', () => {
    expect(call().budget.meters).toHaveLength(1)
    mocks.settings = { ai: {} }
    expect(call().budget).toEqual({ action: 'warn', meters: [], spent: { daily: 1.5 } })
  })
})
