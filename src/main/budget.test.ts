import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BudgetGuard, type SpendLedger } from './budget'
import { startOfLocalDay } from '@shared/budgetPolicy'
import type { BudgetSettings } from '@shared/settings'

// A zone with clock changes: the day boundary is local midnight, not 24 hours back.
const zone = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/New_York' })
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const local = (month: number, day: number, hour = 12, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()

interface Row { ts: number; cost: number; conversationId?: string }

/** A ledger over plain rows, with the same arithmetic as the usage table. */
function ledgerOf(rows: Row[]): SpendLedger & { calls: Array<[number, string | undefined]> } {
  const calls: Array<[number, string | undefined]> = []
  return {
    calls,
    spendSince: (since, conversationId) => {
      calls.push([since, conversationId])
      return rows.filter((row) => row.ts >= since && (conversationId === undefined || row.conversationId === conversationId)).reduce((sum, row) => sum + row.cost, 0)
    }
  }
}

function setup(budget: BudgetSettings | undefined, rows: Row[] = [], now = local(6, 15)) {
  const ledger = ledgerOf(rows)
  const clock = { now }
  const settings = { budget }
  const guard = new BudgetGuard({ settings: () => settings.budget, ledger, now: () => clock.now })
  /** A request that finishes a moment from now: the ledger row the usage table would hold for it. */
  const spend = (cost: number, conversationId = 'c'): void => {
    clock.now += 1_000
    rows.push({ ts: clock.now, cost, conversationId })
  }
  return { guard, rows, ledger, clock, settings, spend }
}

describe('with no cap set', () => {
  it('never stops, says nothing, and does not touch the ledger', () => {
    const throwing: SpendLedger = { spendSince: () => { throw new Error('the ledger must stay closed') } }
    const quiet = new BudgetGuard({ settings: () => undefined, ledger: throwing })
    quiet.beginTurn('c')
    expect(quiet.check('c')).toEqual({ stop: false, notices: [] })
    const empty = new BudgetGuard({ settings: () => ({ action: 'stop' }), ledger: throwing })
    expect(empty.check('c')).toEqual({ stop: false, notices: [] })
  })

  it('reads only the ledger scopes that have a cap', () => {
    const { guard, ledger, clock } = setup({ perTurnUsd: 1, action: 'stop' })
    guard.beginTurn('c')
    guard.check('c')
    expect(ledger.calls).toEqual([[clock.now, 'c']])
  })
})

describe('the turn cap', () => {
  it('warns once at 80 percent, once at the cap, and keeps going when the action is warn', () => {
    const { guard, spend } = setup({ perTurnUsd: 1, action: 'warn' })
    guard.beginTurn('c')
    spend(0.5)
    expect(guard.check('c')).toEqual({ stop: false, notices: [] })
    spend(0.35)
    const warn = guard.check('c')
    expect(warn.stop).toBe(false)
    expect(warn.notices).toHaveLength(1)
    expect(warn.notices[0]).toMatchObject({ scope: 'turn', level: 'warn', action: 'warn', limitUsd: 1, stopped: false })
    expect(warn.notices[0]!.spentUsd).toBeCloseTo(0.85)
    expect(guard.check('c').notices).toEqual([])
    spend(0.2)
    const over = guard.check('c')
    expect(over.stop).toBe(false)
    expect(over.notices).toHaveLength(1)
    expect(over.notices[0]).toMatchObject({ scope: 'turn', level: 'over', stopped: false })
    expect(over.notices[0]!.message).toContain('keeps going')
    expect(guard.check('c').notices).toEqual([])
  })

  it('stops before the next request once the cap is reached, and explains each time it does', () => {
    const { guard, spend } = setup({ perTurnUsd: 0.5, action: 'stop' })
    guard.beginTurn('c')
    spend(0.5)
    for (let attempt = 0; attempt < 2; attempt++) {
      const verdict = guard.check('c')
      expect(verdict.stop).toBe(true)
      expect(verdict.notices).toEqual([expect.objectContaining({ scope: 'turn', level: 'over', stopped: true, message: 'Turn budget of $0.50 reached. Raise it in Settings, or send a new message to start a fresh turn.' })])
    }
  })

  it('counts a subagent or a summary made during the turn, because it is the task\'s spend since the turn began', () => {
    const { guard, spend } = setup({ perTurnUsd: 1, action: 'stop' })
    guard.beginTurn('c')
    spend(0.4)
    spend(0.35)
    spend(0.3)
    expect(guard.check('c').stop).toBe(true)
  })

  it('starts every turn from zero and raises its warnings again', () => {
    const { guard, spend, clock } = setup({ perTurnUsd: 1, action: 'stop' })
    guard.beginTurn('c')
    spend(0.9)
    expect(guard.check('c').notices).toHaveLength(1)
    guard.endTurn('c')
    clock.now += 60_000
    guard.beginTurn('c')
    expect(guard.check('c')).toEqual({ stop: false, notices: [] })
    spend(0.9)
    expect(guard.check('c').notices).toHaveLength(1)
  })

  it('does not count a request made between turns, such as a manual summary', () => {
    const { guard, spend, clock } = setup({ perTurnUsd: 1, action: 'stop' })
    guard.beginTurn('c')
    spend(0.4)
    guard.endTurn('c')
    expect(guard.snapshot('c').turn).toBeUndefined()
    spend(5)
    clock.now += 60_000
    guard.beginTurn('c')
    expect(guard.snapshot('c').turn).toBe(0)
    expect(guard.check('c')).toEqual({ stop: false, notices: [] })
  })

  it('tracks each task on its own', () => {
    const { guard, spend } = setup({ perTurnUsd: 1, action: 'stop' })
    guard.beginTurn('a')
    guard.beginTurn('b')
    spend(2, 'a')
    expect(guard.check('a').stop).toBe(true)
    expect(guard.check('b').stop).toBe(false)
  })
})

describe('the session cap', () => {
  const rows = (cost: number): Row[] => [{ ts: local(6, 1), cost, conversationId: 'c' }, { ts: local(6, 1), cost: 99, conversationId: 'other' }]

  it('measures what this task cost over its whole life, not the others', () => {
    const { guard } = setup({ perSessionUsd: 2, action: 'stop' }, rows(1.7))
    guard.beginTurn('c')
    const verdict = guard.check('c')
    expect(verdict.stop).toBe(false)
    expect(verdict.notices[0]).toMatchObject({ scope: 'session', level: 'warn', spentUsd: 1.7 })
  })

  it('stops when the task reaches the cap, and the message says how to continue', () => {
    const { guard } = setup({ perSessionUsd: 2, action: 'stop' }, rows(2.04))
    guard.beginTurn('c')
    const verdict = guard.check('c')
    expect(verdict.stop).toBe(true)
    expect(verdict.notices[0]!.message).toBe('Session budget of $2.00 reached. Raise it in Settings or start a new session.')
  })

  it('does not warn twice for the same crossing, but warns again after the cap is raised', () => {
    const { guard, settings } = setup({ perSessionUsd: 2, action: 'warn' }, rows(1.7))
    guard.beginTurn('c')
    expect(guard.check('c').notices).toHaveLength(1)
    expect(guard.check('c').notices).toHaveLength(0)
    settings.budget = { perSessionUsd: 2.05, action: 'warn' }
    expect(guard.check('c').notices).toHaveLength(1)
  })

  it('applies a new action from the next check, because settings are read every time', () => {
    const { guard, settings } = setup({ perSessionUsd: 2, action: 'warn' }, rows(2.5))
    guard.beginTurn('c')
    expect(guard.check('c').stop).toBe(false)
    settings.budget = { perSessionUsd: 2, action: 'stop' }
    expect(guard.check('c').stop).toBe(true)
    settings.budget = undefined
    expect(guard.check('c')).toEqual({ stop: false, notices: [] })
  })
})

describe('the daily cap', () => {
  it('counts spend since local midnight only', () => {
    const { guard, ledger } = setup({ dailyUsd: 5, action: 'stop' }, [
      { ts: local(6, 14, 23, 59), cost: 4.9 },
      { ts: local(6, 15, 0, 1), cost: 1 }
    ], local(6, 15, 9))
    guard.beginTurn('c')
    expect(guard.check('c').stop).toBe(false)
    expect(ledger.calls).toEqual([[startOfLocalDay(local(6, 15, 9)), undefined]])
  })

  it('stops at the cap with the sentence from the brief', () => {
    const { guard } = setup({ dailyUsd: 5, action: 'stop' }, [{ ts: local(6, 15, 8), cost: 5.12 }], local(6, 15, 9))
    guard.beginTurn('c')
    const verdict = guard.check('c')
    expect(verdict.stop).toBe(true)
    expect(verdict.notices).toEqual([expect.objectContaining({ scope: 'daily', message: 'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.' })])
  })

  it('starts a new day at local midnight, with the spend and the warnings reset', () => {
    const { guard, clock } = setup({ dailyUsd: 5, action: 'stop' }, [{ ts: local(6, 15, 20), cost: 4.5 }], local(6, 15, 23, 58))
    guard.beginTurn('c')
    expect(guard.check('c').notices).toHaveLength(1)
    expect(guard.check('c').notices).toHaveLength(0)
    clock.now = local(6, 16, 0, 1)
    expect(guard.check('c')).toEqual({ stop: false, notices: [] })
  })

  it('raises the warning again on the next day when the cap is crossed again', () => {
    const rows: Row[] = [{ ts: local(6, 15, 20), cost: 4.5 }]
    const { guard, clock } = setup({ dailyUsd: 5, action: 'warn' }, rows, local(6, 15, 21))
    guard.beginTurn('c')
    expect(guard.check('c').notices).toHaveLength(1)
    clock.now = local(6, 16, 10)
    rows.push({ ts: local(6, 16, 9), cost: 4.2 })
    expect(guard.check('c').notices).toHaveLength(1)
  })

  it('uses the 23 hour day of a clock change as one day, from its own midnight', () => {
    const { guard } = setup({ dailyUsd: 5, action: 'stop' }, [
      { ts: local(3, 7, 23), cost: 100 },
      { ts: local(3, 8, 0, 30), cost: 3 },
      { ts: local(3, 8, 14), cost: 2 }
    ], local(3, 8, 15))
    guard.beginTurn('c')
    expect(guard.check('c').stop).toBe(true)
    expect(guard.snapshot().daily).toBe(5)
  })
})

describe('several caps at once', () => {
  it('reports each scope that crossed, daily first, and stops when any stop-cap is reached', () => {
    const { guard, spend } = setup({ dailyUsd: 10, perSessionUsd: 2, perTurnUsd: 1, action: 'stop' }, [
      { ts: local(6, 15, 8), cost: 8.5, conversationId: 'c' }
    ])
    guard.beginTurn('c')
    spend(1.2)
    const verdict = guard.check('c')
    expect(verdict.stop).toBe(true)
    expect(verdict.notices.map((notice) => [notice.scope, notice.level, notice.stopped])).toEqual([
      ['daily', 'warn', false],
      ['session', 'over', true],
      ['turn', 'over', true]
    ])
  })
})

describe('snapshot', () => {
  it('reports the day, the task and the running turn for the usage view', () => {
    const { guard, spend } = setup({ dailyUsd: 5 }, [
      { ts: local(6, 15, 8), cost: 1.5, conversationId: 'c' },
      { ts: local(6, 14, 8), cost: 7, conversationId: 'c' },
      { ts: local(6, 15, 9), cost: 0.5, conversationId: 'other' }
    ])
    guard.beginTurn('c')
    spend(0.25)
    expect(guard.snapshot('c')).toEqual({ turn: 0.25, session: 8.75, daily: 2.25 })
    expect(guard.snapshot()).toEqual({ daily: 2.25 })
    expect(guard.snapshot('never-ran')).toEqual({ session: 0, daily: 2.25 })
  })

  it('forgets a deleted task, including its warnings', () => {
    const { guard } = setup({ perSessionUsd: 1, action: 'warn' }, [{ ts: local(6, 15, 8), cost: 0.9, conversationId: 'c' }])
    guard.beginTurn('c')
    expect(guard.check('c').notices).toHaveLength(1)
    expect(guard.check('c').notices).toHaveLength(0)
    guard.forget('c')
    expect(guard.snapshot('c').turn).toBeUndefined()
    expect(guard.check('c').notices).toHaveLength(1)
  })
})

describe('blocker', () => {
  it('is undefined while no stop cap is reached, and for every cap when the action is warn', () => {
    const { guard } = setup({ dailyUsd: 5, action: 'stop' }, [{ ts: local(6, 15, 8), cost: 4.5 }])
    expect(guard.blocker('c')).toBeUndefined()
    const warnOnly = setup({ dailyUsd: 5, action: 'warn' }, [{ ts: local(6, 15, 8), cost: 9 }])
    expect(warnOnly.guard.blocker('c')).toBeUndefined()
    expect(setup(undefined).guard.blocker('c')).toBeUndefined()
  })

  it('gives the sentence for each cap that is reached, so a summary on demand can say why it did not run', () => {
    const { guard } = setup({ dailyUsd: 5, perSessionUsd: 2, action: 'stop' }, [{ ts: local(6, 15, 8), cost: 5.5, conversationId: 'c' }])
    expect(guard.blocker('c')).toBe(
      'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight. ' +
      'Session budget of $2.00 reached. Raise it in Settings or start a new session.'
    )
  })

  it('raises nothing, so the next turn still shows its warnings', () => {
    const { guard } = setup({ dailyUsd: 5, perSessionUsd: 5, action: 'stop' }, [{ ts: local(6, 15, 8), cost: 4.2, conversationId: 'c' }])
    guard.beginTurn('c')
    expect(guard.blocker('c')).toBeUndefined()
    expect(guard.check('c').notices.map((notice) => notice.scope)).toEqual(['daily', 'session'])
  })
})

describe('the clock', () => {
  it('is read on every check, never captured at construction', () => {
    const now = vi.fn(() => local(6, 15))
    const ledger = ledgerOf([])
    const guard = new BudgetGuard({ settings: () => ({ dailyUsd: 5 }), ledger, now })
    guard.check('c')
    guard.check('c')
    expect(now).toHaveBeenCalledTimes(2)
  })
})
