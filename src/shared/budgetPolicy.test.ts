import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BUDGET_SCOPES,
  budgetLimit,
  budgetMessage,
  budgetMeters,
  budgetScopeName,
  budgetState,
  formatUsd,
  isBudgetMessage,
  parseUsdInput,
  startOfLocalDay
} from './budgetPolicy'

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
  it('lists only the caps that are set, daily first, with their state', () => {
    const meters = budgetMeters({ perTurnUsd: 1, dailyUsd: 10 }, { turn: 0.9, session: 3, daily: 4 })
    expect(meters).toEqual([
      { scope: 'daily', limitUsd: 10, spentUsd: 4, state: 'ok' },
      { scope: 'turn', limitUsd: 1, spentUsd: 0.9, state: 'warn' }
    ])
  })

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

  it('counts a day that is 25 hours long (clocks go back on 1 November) from its own midnight', () => {
    expect(startOfLocalDay(local(11, 1, 20))).toBe(local(11, 1))
    expect(local(11, 2) - local(11, 1)).toBe(25 * 3600_000)
    expect(startOfLocalDay(local(11, 2, 6), 1)).toBe(local(11, 1))
  })

  it('walks back whole calendar days across a clock change and a month end', () => {
    expect(startOfLocalDay(local(3, 12, 9), 6)).toBe(local(3, 6))
    expect(startOfLocalDay(local(3, 3, 9), 5)).toBe(local(2, 26))
    expect(startOfLocalDay(local(1, 2, 9), 29)).toBe(new Date(2025, 11, 4).getTime())
  })

  it('treats a moment just before and just after midnight as different days', () => {
    const justBefore = new Date(2026, 5, 15, 23, 59, 59, 999).getTime()
    expect(startOfLocalDay(justBefore + 1)).toBe(local(6, 16))
    expect(startOfLocalDay(justBefore)).toBe(local(6, 15))
  })
})

describe('formatUsd', () => {
  it('shows cents, thousands separators and a floor for tiny amounts', () => {
    expect(formatUsd(5)).toBe('$5.00')
    expect(formatUsd(0.5)).toBe('$0.50')
    expect(formatUsd(1240.5)).toBe('$1,240.50')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(Number.NaN)).toBe('$0.00')
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

describe('isBudgetMessage and budgetScopeName', () => {
  it('recognizes the sentences the budget writes, and nothing else', () => {
    for (const scope of BUDGET_SCOPES) {
      const text = budgetMessage({ scope, level: 'over', action: 'stop', spentUsd: 6, limitUsd: 5, stopped: true })
      expect(isBudgetMessage(text), text).toBe(true)
    }
    expect(isBudgetMessage('  Daily budget of $5.00 reached. Raise it in Settings or wait until midnight. Session budget of $2.00 reached.')).toBe(true)
    expect(isBudgetMessage('Provider unavailable')).toBe(false)
    expect(isBudgetMessage('The daily budget of the team is large')).toBe(false)
  })

  it('names each cap in lower case for running text', () => {
    expect(BUDGET_SCOPES.map(budgetScopeName)).toEqual(['daily', 'session', 'turn'])
  })
})

describe('budgetMessage', () => {
  const base = { spentUsd: 5.12, limitUsd: 5, action: 'stop' as const }

  it('says what happened and how to fix it when a day cap stops the turn', () => {
    expect(budgetMessage({ ...base, scope: 'daily', level: 'over', stopped: true })).toBe('Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.')
  })

  it('points a session cap at a new session and a turn cap at a new message', () => {
    expect(budgetMessage({ ...base, scope: 'session', limitUsd: 2, level: 'over', stopped: true })).toBe('Session budget of $2.00 reached. Raise it in Settings or start a new session.')
    expect(budgetMessage({ ...base, scope: 'turn', limitUsd: 0.5, level: 'over', stopped: true })).toBe('Turn budget of $0.50 reached. Raise it in Settings, or send a new message to start a fresh turn.')
  })

  it('tells a warn-only cap that work continues and how to enforce it', () => {
    const text = budgetMessage({ ...base, action: 'warn', scope: 'daily', level: 'over', stopped: false })
    expect(text).toContain('Daily budget of $5.00 reached ($5.12 spent)')
    expect(text).toContain('keeps going')
    expect(text).toContain('stop in Settings')
  })

  it('warns at 80 percent with the percentage, the amount and what happens next', () => {
    const stop = budgetMessage({ scope: 'daily', level: 'warn', action: 'stop', spentUsd: 4.1, limitUsd: 5, stopped: false })
    expect(stop).toBe('Daily spend is at 82% of the $5.00 budget ($4.10 so far). Cubex ends the turn at 100%. Raise it in Settings if you need more room.')
    const warn = budgetMessage({ scope: 'session', level: 'warn', action: 'warn', spentUsd: 1.6, limitUsd: 2, stopped: false })
    expect(warn).toContain('Session spend is at 80% of the $2.00 budget')
    expect(warn).toContain('warns again at 100%')
  })

  it('never apologizes, shouts or uses a spaced dash', () => {
    for (const scope of BUDGET_SCOPES) {
      for (const level of ['warn', 'over'] as const) {
        for (const action of ['warn', 'stop'] as const) {
          const text = budgetMessage({ scope, level, action, spentUsd: 4.2, limitUsd: 5, stopped: level === 'over' && action === 'stop' })
          expect(text).not.toMatch(/sorry|oops|unfortunately|!| — /i)
        }
      }
    }
  })
})
