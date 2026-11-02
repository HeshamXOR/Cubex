import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUDGET_SCOPES, budgetLimit, budgetMeters, budgetState, parseUsdInput, startOfLocalDay } from './budgetPolicy'

// A zone with clock changes, so the day-boundary tests cross a 23 hour and a 25 hour day.
const zone = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/New_York' })
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe('budgetLimit', () => {
  it('reads each scope from its own key and ignores caps that are not positive numbers', () => {
    const budget = { perTurnUsd: 0.5, perSessionUsd: 2, dailyUsd: 5 }
    expect(BUDGET_SCOPES.map((scope) => budgetLimit(budget, scope))).toEqual([5, 2, 0.5])
    expect(budgetLimit({ dailyUsd: 0 }, 'daily')).toBeUndefined()
    expect(budgetLimit({ dailyUsd: -1 }, 'daily')).toBeUndefined()
    expect(budgetLimit({ dailyUsd: Number.NaN }, 'daily')).toBeUndefined()
    expect(budgetLimit(undefined, 'turn')).toBeUndefined()
  })
})

describe('budgetState', () => {
  it('is ok below 80 percent, warn from 80, and over from the cap itself', () => {
    expect(budgetState(3.99, 5)).toBe('ok')
    expect(budgetState(4, 5)).toBe('warn')
    expect(budgetState(4.99, 5)).toBe('warn')
    expect(budgetState(5, 5)).toBe('over')
    expect(budgetState(12, 5)).toBe('over')
    expect(budgetState(0, 5)).toBe('ok')
  })

  it('is not thrown off by float sums that land a hair under the threshold', () => {
    expect(budgetState(0.1 + 0.2, 0.3)).toBe('over')
    expect(budgetState(2.4, 3)).toBe('warn')
    expect(3 * 0.8).not.toBe(2.4)
  })
})

describe('budgetMeters', () => {

  it('leaves out a cap whose spend is unknown, such as a session cap with no session open', () => {
    expect(budgetMeters({ perSessionUsd: 2, dailyUsd: 10 }, { daily: 1 })).toEqual([{ scope: 'daily', limitUsd: 10, spentUsd: 1, state: 'ok' }])
    expect(budgetMeters(undefined, { daily: 1 })).toEqual([])
  })
})

describe('startOfLocalDay', () => {
  const local = (month: number, day: number, hour = 0): number => new Date(2026, month - 1, day, hour).getTime()

  it('is local midnight of the same day, whatever the time of day', () => {
    expect(startOfLocalDay(local(6, 15, 0))).toBe(local(6, 15))
    expect(startOfLocalDay(local(6, 15, 13))).toBe(local(6, 15))
    expect(startOfLocalDay(new Date(2026, 5, 15, 23, 59, 59, 999).getTime())).toBe(local(6, 15))
  })

  it('counts a day that is 23 hours long (clocks go forward on 8 March) from its own midnight', () => {
    expect(startOfLocalDay(local(3, 8, 15))).toBe(local(3, 8))
    expect(local(3, 9) - local(3, 8)).toBe(23 * 3600_000)
    expect(startOfLocalDay(local(3, 9, 1), 1)).toBe(local(3, 8))
  })

})

describe('parseUsdInput', () => {
  it('reads dollars and cents, with or without a dollar sign and thousands separators', () => {
    for (const [typed, usd] of [['5', 5], ['$5', 5], ['0.50', 0.5], ['.5', 0.5], ['5.', 5], [' $1,240.50 ', 1240.5], ['12.3', 12.3]] as const) {
      expect(parseUsdInput(typed), typed).toEqual({ ok: true, usd })
    }
  })

  it('treats an empty field as no cap, so clearing it removes the limit', () => {
    expect(parseUsdInput('')).toEqual({ ok: true, usd: 0 })
    expect(parseUsdInput('  ')).toEqual({ ok: true, usd: 0 })
    expect(parseUsdInput('$')).toEqual({ ok: true, usd: 0 })
  })

  it('rejects what is not an amount of money', () => {
    for (const typed of ['abc', '-5', '5.001', '1e3', '5,5,5.5.5', '5 dollars', '$$5', '0x10', 'Infinity', '5.5.5']) {
      expect(parseUsdInput(typed), typed).toEqual({ ok: false, reason: 'format' })
    }
  })

  it('rejects an amount no one means to type', () => {
    expect(parseUsdInput('1000000')).toEqual({ ok: true, usd: 1_000_000 })
    expect(parseUsdInput('1000000.01')).toEqual({ ok: false, reason: 'large' })
    expect(parseUsdInput('99999999999999999999')).toEqual({ ok: false, reason: 'large' })
  })
})
