import { describe, expect, it, vi } from 'vitest'
import { PowerKeeper, type PowerBlocker } from './PowerKeeper'

function fixture(initial: { busy?: boolean; enabled?: boolean } = {}) {
  const state = { busy: initial.busy ?? false, enabled: initial.enabled ?? true }
  const calls: string[] = []
  let next = 1
  const blocker: PowerBlocker = {
    start: (type) => { calls.push(`start ${type}`); return next++ },
    stop: (id) => { calls.push(`stop ${id}`) }
  }
  const keeper = new PowerKeeper({ blocker, busy: () => state.busy, enabled: () => state.enabled })
  return { state, calls, keeper }
}

describe('PowerKeeper', () => {
  it('holds while work is running and lets go when it ends', () => {
    const { state, calls, keeper } = fixture()
    keeper.check()
    expect(keeper.holding).toBe(false)
    state.busy = true
    keeper.check()
    expect(keeper.holding).toBe(true)
    keeper.check()
    expect(calls).toEqual(['start prevent-app-suspension'])
    state.busy = false
    keeper.check()
    expect(keeper.holding).toBe(false)
    expect(calls).toEqual(['start prevent-app-suspension', 'stop 1'])
  })

  it('never holds while the setting is off, and lets go when it is turned off', () => {
    const { state, calls, keeper } = fixture({ busy: true, enabled: false })
    keeper.check()
    expect(calls).toEqual([])
    state.enabled = true
    keeper.check()
    expect(keeper.holding).toBe(true)
    state.enabled = false
    keeper.check()
    expect(keeper.holding).toBe(false)
    expect(calls).toEqual(['start prevent-app-suspension', 'stop 1'])
  })

  it('takes a new hold for each stretch of work', () => {
    const { state, calls, keeper } = fixture({ busy: true })
    keeper.check()
    state.busy = false
    keeper.check()
    state.busy = true
    keeper.check()
    expect(calls).toEqual(['start prevent-app-suspension', 'stop 1', 'start prevent-app-suspension'])
  })

  it('counts a question that throws as nothing to hold for, and drops a hold it cannot confirm', () => {
    const calls: string[] = []
    let broken = false
    const keeper = new PowerKeeper({
      blocker: { start: () => { calls.push('start'); return 7 }, stop: (id) => { calls.push(`stop ${id}`) } },
      busy: () => { if (broken) throw new Error('chat service is gone'); return true },
      enabled: () => true
    })
    keeper.check()
    expect(keeper.holding).toBe(true)
    broken = true
    expect(() => keeper.check()).not.toThrow()
    expect(keeper.holding).toBe(false)
    expect(calls).toEqual(['start', 'stop 7'])
  })

  it('survives a blocker that fails to start or to stop', () => {
    const keeper = new PowerKeeper({
      blocker: { start: () => { throw new Error('no power service') }, stop: () => { throw new Error('already gone') } },
      busy: () => true,
      enabled: () => true
    })
    expect(() => keeper.check()).not.toThrow()
    expect(keeper.holding).toBe(false)
  })

  it('releases on dispose and stops looking', () => {
    vi.useFakeTimers()
    try {
      const { state, calls, keeper } = fixture({ busy: true })
      keeper.start()
      keeper.start()
      expect(calls).toEqual([])
      vi.advanceTimersByTime(4_000)
      expect(calls).toEqual(['start prevent-app-suspension'])
      keeper.dispose()
      expect(calls).toEqual(['start prevent-app-suspension', 'stop 1'])
      state.busy = true
      vi.advanceTimersByTime(20_000)
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
