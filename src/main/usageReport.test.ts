import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startOfLocalDay } from '@shared/budgetPolicy'
import { buildUsageReport, summarizeUsage, type UsageSource } from './usageReport'
import type { UsageGroup } from './db'

const zone = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/New_York' })
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const group = (overrides: Partial<UsageGroup> = {}): UsageGroup => ({
  providerId: 'anthropic', model: 'claude-sonnet', execution: 'cloud', costSource: 'catalog', requests: 4, cost: 1.5, tokens: 12_000, ...overrides
})

describe('summarizeUsage', () => {
  it('adds up cost, requests and tokens, and ranks providers and models by cost', () => {
    const period = summarizeUsage([
      group({ providerId: 'openai', model: 'gpt-small', cost: 0.25, requests: 10, tokens: 40_000 }),
      group({ providerId: 'anthropic', model: 'claude-sonnet', cost: 1.5 }),
      group({ providerId: 'anthropic', model: 'claude-haiku', cost: 0.5, requests: 2, tokens: 3_000 })
    ])
    expect(period.costUsd).toBe(2.25)
    expect(period.requests).toBe(16)
    expect(period.tokens).toBe(55_000)
    expect(period.byProvider.map((row) => [row.id, row.costUsd, row.requests])).toEqual([['anthropic', 2, 6], ['openai', 0.25, 10]])
    expect(period.byModel.map((row) => [row.id, row.providerId])).toEqual([['claude-sonnet', 'anthropic'], ['claude-haiku', 'anthropic'], ['gpt-small', 'openai']])
  })
})

describe('buildUsageReport', () => {
  const noon = new Date(2026, 5, 15, 12).getTime()
  /** A ledger that records which periods were asked for and answers with one row each. */
  function ledger() {
    const asked: number[] = []
    const source: UsageSource = { breakdownSince: (since) => { asked.push(since); return [group({ cost: since === startOfLocalDay(noon) ? 1 : 2 })] } }
    return { source, asked }
  }

  it('measures today from local midnight, and seven and thirty days as whole calendar days with today included', () => {
    const { source, asked } = ledger()
    const report = buildUsageReport({ source, budget: undefined, spend: { daily: 1 }, now: noon })
    expect(asked).toEqual([startOfLocalDay(noon), startOfLocalDay(noon, 6), startOfLocalDay(noon, 29)])
    expect(report.generatedAt).toBe(noon)
    expect([report.today.costUsd, report.week.costUsd, report.month.costUsd]).toEqual([1, 2, 2])
  })

  it('draws a meter for each cap that is set, with the state the guard would give', () => {
    const { source } = ledger()
    const report = buildUsageReport({
      source, budget: { dailyUsd: 5, perSessionUsd: 2, perTurnUsd: 1, action: 'stop' },
      spend: { daily: 4.5, session: 2.4, turn: 0.1 }, now: noon
    })
    expect(report.budget).toEqual({
      action: 'stop',
      meters: [
        { scope: 'daily', limitUsd: 5, spentUsd: 4.5, state: 'warn' },
        { scope: 'session', limitUsd: 2, spentUsd: 2.4, state: 'over' },
        { scope: 'turn', limitUsd: 1, spentUsd: 0.1, state: 'ok' }
      ],
      spent: { daily: 4.5, session: 2.4, turn: 0.1 }
    })
  })
})
