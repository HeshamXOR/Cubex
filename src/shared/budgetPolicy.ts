import type { BudgetMeter, BudgetNotice, BudgetScope, BudgetState } from './ipc'
import type { BudgetSettings } from './settings'
import { MAX_BUDGET_USD } from './contextPolicy'

/**
 * Budget arithmetic and wording, shared by the main process (which enforces the caps) and the renderer
 * (which draws the same states), so a bar that turns amber is a notice that was actually raised.
 */

/** A spend from this share of a cap warns; from the cap itself it is over. */
export const BUDGET_WARN_RATIO = 0.8

/** Display order: the day first, because it is the one that spans sessions. */
export const BUDGET_SCOPES: readonly BudgetScope[] = ['daily', 'session', 'turn']

const LIMIT_KEY = { turn: 'perTurnUsd', session: 'perSessionUsd', daily: 'dailyUsd' } as const
/** Spend is a sum of floats; this keeps 0.30000000000000004 from missing a 0.30 cap. */
const EPSILON = 1e-9

/** The cap for a scope, or undefined when it is not set. Zero and negative amounts mean "no cap". */
export function budgetLimit(budget: BudgetSettings | undefined, scope: BudgetScope): number | undefined {
  const value = budget?.[LIMIT_KEY[scope]]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function budgetState(spentUsd: number, limitUsd: number): BudgetState {
  if (spentUsd + EPSILON >= limitUsd) return 'over'
  if (spentUsd + EPSILON >= limitUsd * BUDGET_WARN_RATIO) return 'warn'
  return 'ok'
}

/** Meters for the caps that are set and have a spend to compare: a session cap needs an open session. */
export function budgetMeters(budget: BudgetSettings | undefined, spent: Partial<Record<BudgetScope, number>>): BudgetMeter[] {
  return BUDGET_SCOPES.flatMap((scope) => {
    const limitUsd = budgetLimit(budget, scope)
    const spentUsd = spent[scope]
    return limitUsd === undefined || spentUsd === undefined
      ? []
      : [{ scope, limitUsd, spentUsd, state: budgetState(spentUsd, limitUsd) }]
  })
}

/**
 * Local midnight of the day containing `now`, or of the day `daysBack` before it. Built with the calendar
 * rather than by subtracting 24 hours, so a day that is 23 or 25 hours long (a clock change) still starts
 * at midnight.
 */
export function startOfLocalDay(now: number, daysBack = 0): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  if (daysBack > 0) day.setDate(day.getDate() - daysBack)
  return day.getTime()
}

/** $5.00, $1,240.50, or <$0.01 for a spend too small to show in cents. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00'
  if (amount < 0.01) return '<$0.01'
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * A dollar amount as typed in Settings. Empty means no cap (zero). A leading $ and thousands separators are
 * accepted; more than cents, a negative number or text is rejected, so the field can say what it wants.
 */
export function parseUsdInput(text: string): { ok: true; usd: number } | { ok: false; reason: 'format' | 'large' } {
  const typed = text.trim().replace(/^\$/, '').replace(/,/g, '').trim()
  if (typed === '') return { ok: true, usd: 0 }
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(typed)) return { ok: false, reason: 'format' }
  const usd = Number(typed)
  return usd > MAX_BUDGET_USD ? { ok: false, reason: 'large' } : { ok: true, usd }
}

const SCOPE_LABEL: Record<BudgetScope, string> = { daily: 'Daily', session: 'Session', turn: 'Turn' }
const HOW_TO_FIX: Record<BudgetScope, string> = {
  daily: 'Raise it in Settings or wait until midnight.',
  session: 'Raise it in Settings or start a new session.',
  turn: 'Raise it in Settings, or send a new message to start a fresh turn.'
}

/** What happened and how to fix it, in one or two sentences. No apology, no alarm. */
export function budgetMessage(notice: Omit<BudgetNotice, 'message'>): string {
  const label = SCOPE_LABEL[notice.scope]
  const limit = formatUsd(notice.limitUsd)
  const spent = formatUsd(notice.spentUsd)
  if (notice.level === 'over' && notice.stopped) return `${label} budget of ${limit} reached. ${HOW_TO_FIX[notice.scope]}`
  if (notice.level === 'over') {
    return `${label} budget of ${limit} reached (${spent} spent). The action is set to warn, so Cubex keeps going. Set it to stop in Settings to enforce the cap.`
  }
  const percent = Math.floor((notice.spentUsd / notice.limitUsd) * 100)
  const consequence = notice.action === 'stop' ? 'Cubex ends the turn at 100%.' : 'Cubex keeps going and warns again at 100%.'
  return `${label} spend is at ${percent}% of the ${limit} budget (${spent} so far). ${consequence} Raise it in Settings if you need more room.`
}

/** True for a reason that comes from a cap, such as a summary on demand that was refused for the budget. */
export function isBudgetMessage(text: string): boolean {
  return /^(?:Daily|Session|Turn) budget of /.test(text.trim())
}

/** The cap's name in running text: "daily", "session" or "turn". */
export function budgetScopeName(scope: BudgetScope): string {
  return SCOPE_LABEL[scope].toLowerCase()
}
