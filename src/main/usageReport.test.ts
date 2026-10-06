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

  it('is empty and zero when nothing was spent', () => {
    expect(summarizeUsage([])).toEqual({ costUsd: 0, requests: 0, tokens: 0, byProvider: [], byModel: [] })
  })

  it('keeps one model through two providers as two rows, because the prices differ', () => {
    const period = summarizeUsage([
      group({ providerId: 'anthropic', model: 'claude-sonnet', cost: 1 }),
      group({ providerId: 'openrouter', model: 'claude-sonnet', cost: 3 })
    ])
    expect(period.byModel.map((row) => [row.providerId, row.costUsd])).toEqual([['openrouter', 3], ['anthropic', 1]])
  })

  it('merges the price sources of one model into one row', () => {
    const period = summarizeUsage([
      group({ costSource: 'catalog', cost: 1, requests: 2 }),
      group({ costSource: 'reported', cost: 2, requests: 3 })
    ])
    expect(period.byModel).toHaveLength(1)
    expect(period.byModel[0]).toMatchObject({ costUsd: 3, requests: 5 })
  })

  it('ranks equal costs by tokens and then by name, so the order never shuffles between refreshes', () => {
    const period = summarizeUsage([
      group({ model: 'b', cost: 0, tokens: 10, costSource: 'reported' }),
      group({ model: 'a', cost: 0, tokens: 10, costSource: 'reported' }),
      group({ model: 'c', cost: 0, tokens: 99, costSource: 'reported' })
    ])
    expect(period.byModel.map((row) => row.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('what is flagged as an estimate', () => {
  const flags = (overrides: Partial<UsageGroup>) => {
    const row = summarizeUsage([group(overrides)]).byModel[0]!
    return { estimated: row.estimated, unpriced: row.unpriced, local: row.local }
  }

  it('does not flag a price from the catalog, from the provider or from the user', () => {
    for (const costSource of ['catalog', 'reported', 'user']) expect(flags({ costSource })).toEqual({})
  })

  it('flags a price from the built-in table as an estimate', () => {
    expect(flags({ costSource: 'estimated', cost: 0.4 })).toEqual({ estimated: true })
  })

  it('flags tokens with no price as unpriced, not as a free model', () => {
    expect(flags({ costSource: 'estimated', cost: 0, tokens: 5_000 })).toEqual({ unpriced: true })
  })

  it('marks a model on this computer as local, whatever it cost', () => {
    expect(flags({ execution: 'local', costSource: 'estimated', cost: 0 })).toEqual({ local: true })
  })

  it('does not call a cloud model with no tokens unpriced', () => {
    expect(flags({ costSource: 'estimated', cost: 0, tokens: 0 })).toEqual({})
  })

  it('carries a flag up to the provider when any of its models has it, and local only when all of them are', () => {
    const period = summarizeUsage([
      group({ providerId: 'mix', model: 'cloud-priced', cost: 1 }),
      group({ providerId: 'mix', model: 'cloud-unpriced', costSource: 'estimated', cost: 0 }),
      group({ providerId: 'mix', model: 'on-device', execution: 'local', costSource: 'estimated', cost: 0 }),
      group({ providerId: 'offline', model: 'one', execution: 'local', costSource: 'estimated', cost: 0 }),
      group({ providerId: 'offline', model: 'two', execution: 'local', costSource: 'estimated', cost: 0 })
    ])
    const byId = Object.fromEntries(period.byProvider.map((row) => [row.id, row]))
    expect(byId.mix).toMatchObject({ unpriced: true })
    expect(byId.mix!.local).toBeUndefined()
    expect(byId.offline).toMatchObject({ local: true })
    expect(byId.offline!.unpriced).toBeUndefined()
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

  it('crosses a clock change by calendar day, not by 24 hour steps', () => {
    const lateMarch = new Date(2026, 2, 9, 12).getTime()
    const { source, asked } = ledger()
    buildUsageReport({ source, budget: undefined, spend: { daily: 0 }, now: lateMarch })
    expect(asked[1]).toBe(new Date(2026, 2, 3).getTime())
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

  it('has no meters without caps, leaves out a cap with nothing to compare, and defaults the action to warn', () => {
    const { source } = ledger()
    expect(buildUsageReport({ source, budget: undefined, spend: { daily: 3 }, now: noon }).budget).toEqual({ action: 'warn', meters: [], spent: { daily: 3 } })
    const noTask = buildUsageReport({ source, budget: { dailyUsd: 5, perSessionUsd: 2 }, spend: { daily: 3 }, now: noon })
    expect(noTask.budget.meters.map((meter) => meter.scope)).toEqual(['daily'])
  })
})
