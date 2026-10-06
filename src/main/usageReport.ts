import type { UsagePeriod, UsageReport, UsageRow } from '@shared/ipc'
import type { BudgetSettings } from '@shared/settings'
import { budgetMeters, startOfLocalDay } from '@shared/budgetPolicy'
import type { SpendSnapshot } from './budget'
import type { UsageGroup } from './db'

/**
 * The usage view's numbers: spend today, over seven days and over thirty, by provider and by model, next to the
 * budget caps. Days are local calendar days, so "today" is the same period the daily cap is measured over.
 */

export interface UsageSource {
  breakdownSince(since: number): UsageGroup[]
}

/** Days the longer periods cover, today included. */
export const WEEK_DAYS = 7
export const MONTH_DAYS = 30

interface Flags {
  local: boolean
  /** Tokens were used but the model has no price, so nothing was added to the cost. */
  unpriced: boolean
  /** A price from the built-in table rather than a catalog, a provider report or the user. */
  estimated: boolean
}

function flagsOf(group: UsageGroup): Flags {
  const local = group.execution === 'local'
  const fromTable = !local && group.costSource === 'estimated'
  return { local, unpriced: fromTable && group.cost <= 0 && group.tokens > 0, estimated: fromTable && group.cost > 0 }
}

interface Accumulator {
  id: string
  providerId?: string
  costUsd: number
  requests: number
  tokens: number
  local: boolean
  unpriced: boolean
  estimated: boolean
}

function rowOf(entry: Accumulator): UsageRow {
  return {
    id: entry.id,
    ...(entry.providerId !== undefined ? { providerId: entry.providerId } : {}),
    costUsd: entry.costUsd,
    requests: entry.requests,
    tokens: entry.tokens,
    ...(entry.estimated ? { estimated: true } : {}),
    ...(entry.unpriced ? { unpriced: true } : {}),
    ...(entry.local ? { local: true } : {})
  }
}

function rank(rows: UsageRow[]): UsageRow[] {
  return rows.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.id.localeCompare(b.id))
}

/** Add the groups up by a key; a row is local only when everything in it was, and unpriced when anything in it was. */
function fold(groups: readonly UsageGroup[], keyOf: (group: UsageGroup) => { key: string; id: string; providerId?: string }): UsageRow[] {
  const entries = new Map<string, Accumulator>()
  for (const group of groups) {
    const { key, id, providerId } = keyOf(group)
    const flags = flagsOf(group)
    const entry = entries.get(key)
    if (entry) {
      entry.costUsd += group.cost
      entry.requests += group.requests
      entry.tokens += group.tokens
      entry.local &&= flags.local
      entry.unpriced ||= flags.unpriced
      entry.estimated ||= flags.estimated
    } else {
      entries.set(key, {
        id, ...(providerId !== undefined ? { providerId } : {}),
        costUsd: group.cost, requests: group.requests, tokens: group.tokens, ...flags
      })
    }
  }
  return rank([...entries.values()].map(rowOf))
}

export function summarizeUsage(groups: readonly UsageGroup[]): UsagePeriod {
  return {
    costUsd: groups.reduce((sum, group) => sum + group.cost, 0),
    requests: groups.reduce((sum, group) => sum + group.requests, 0),
    tokens: groups.reduce((sum, group) => sum + group.tokens, 0),
    byProvider: fold(groups, (group) => ({ key: group.providerId, id: group.providerId })),
    // The same model id through two providers is two prices, so it is two rows.
    byModel: fold(groups, (group) => ({ key: `${group.providerId}\n${group.model}`, id: group.model, providerId: group.providerId }))
  }
}

export interface UsageReportInput {
  source: UsageSource
  budget: BudgetSettings | undefined
  /** What the day, the open task and its running turn have cost, from the budget guard. */
  spend: SpendSnapshot
  now?: number
}

export function buildUsageReport({ source, budget, spend, now = Date.now() }: UsageReportInput): UsageReport {
  const period = (days: number): UsagePeriod => summarizeUsage(source.breakdownSince(startOfLocalDay(now, days - 1)))
  return {
    generatedAt: now,
    today: period(1),
    week: period(WEEK_DAYS),
    month: period(MONTH_DAYS),
    budget: { action: budget?.action === 'stop' ? 'stop' : 'warn', meters: budgetMeters(budget, spend), spent: spend }
  }
}
