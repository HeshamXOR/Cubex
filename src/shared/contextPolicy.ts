import { normalizeTimeoutConfig } from '@core/types'
import type { AppSettings, BudgetSettings, CompactionSettings } from './settings'

/**
 * What the compaction and budget settings mean, resolved in one place. The main process acts on these
 * values and the renderer draws them (the tick on the context meter, the Settings controls), so the
 * threshold the user sees is the threshold Cubex uses. Stored JSON can be damaged or older than the
 * current keys, so every reader goes through here instead of trusting the raw fields.
 */

export const DEFAULT_COMPACTION_THRESHOLD = 0.8
export const MIN_COMPACTION_THRESHOLD = 0.5
export const MAX_COMPACTION_THRESHOLD = 0.95

/** The largest cap a person can enter. Anything bigger is a typo, not a budget. */
export const MAX_BUDGET_USD = 1_000_000

export interface CompactionPolicy {
  /** Summarize older messages before a request that reaches the threshold. */
  auto: boolean
  /** Share of the usable input budget (0.5 to 0.95) at which automatic summarizing starts. */
  threshold: number
  /** Replace old tool output with short stubs during a long turn, before summarizing. */
  prune: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** In range and rounded to a whole percent, so the slider and the stored value always agree. */
export function clampThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_COMPACTION_THRESHOLD
  return Math.round(Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, value)) * 100) / 100
}

/**
 * `ai.compaction.auto` wins when it is a boolean; otherwise the older `ai.autoCompact` decides, and only
 * an explicit `false` turns it off. A damaged value must not silently leave a long conversation to
 * overflow the window.
 */
export function resolveCompactionPolicy(ai: unknown): CompactionPolicy {
  const settings = isRecord(ai) ? ai : {}
  const compaction = isRecord(settings.compaction) ? settings.compaction : {}
  return {
    auto: typeof compaction.auto === 'boolean' ? compaction.auto : settings.autoCompact !== false,
    threshold: clampThreshold(compaction.threshold),
    prune: compaction.prune !== false
  }
}

/** Token count at which automatic summarizing starts, for a given input budget. */
export function autoCompactAt(budgetTokens: number, threshold: number): number {
  return Math.floor(budgetTokens * threshold)
}

/**
 * Pruning old tool output is the gentler step, so it starts earlier than summarizing: 0.6 of the budget
 * by default, and never closer than 0.1 to a lower summarizing threshold.
 */
export function pruneStartsAt(threshold: number): number {
  return Math.min(0.6, Math.round((threshold - 0.1) * 100) / 100)
}

/** A cap is a positive dollar amount in whole cents. Anything else means "no cap". */
export function normalizeBudgetAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const cents = Math.round(Math.min(MAX_BUDGET_USD, value) * 100)
  return cents >= 1 ? cents / 100 : undefined
}

export function normalizeBudget(value: unknown): BudgetSettings | undefined {
  if (!isRecord(value)) return undefined
  const budget: BudgetSettings = { action: value.action === 'stop' ? 'stop' : 'warn' }
  for (const key of ['perTurnUsd', 'perSessionUsd', 'dailyUsd'] as const) {
    const amount = normalizeBudgetAmount(value[key])
    if (amount !== undefined) budget[key] = amount
  }
  return budget
}

/**
 * Bring the compaction, budget and timeout keys of `ai` into their canonical shape. Run on load and before every
 * save, it keeps `autoCompact` and `compaction.auto` equal, so no reader of either key can disagree with
 * the other, it drops caps that are zero, negative or not numbers (clearing a field sends 0), and it keeps the
 * three request limits finite and no longer than a day.
 */
export function normalizeAiPolicy(ai: AppSettings['ai']): AppSettings['ai'] {
  const policy = resolveCompactionPolicy(ai)
  const compaction: CompactionSettings = { auto: policy.auto, threshold: policy.threshold, prune: policy.prune }
  const { budget: storedBudget, ...rest } = ai
  const budget = normalizeBudget(storedBudget)
  return { ...rest, autoCompact: policy.auto, compaction, timeout: normalizeTimeoutConfig(rest.timeout), ...(budget ? { budget } : {}) }
}
