import type { BudgetNotice, BudgetScope } from '@shared/ipc'
import type { BudgetSettings } from '@shared/settings'
import { BUDGET_SCOPES, budgetLimit, budgetMessage, budgetState, startOfLocalDay } from '@shared/budgetPolicy'

/**
 * Enforces `ai.budget`. Before every model request of a turn it compares what the turn, the session and the
 * local day have cost against the caps that are set. A warning is raised once per crossing of 80 and of 100
 * percent; with the action `stop`, reaching a cap ends the turn before the request that would go beyond it,
 * every time, because each blocked attempt deserves its explanation.
 *
 * All money comes from the usage ledger, which records every request, so the turn, the session and the day
 * include summaries and subagents without anyone adding them up a second time. A turn is the spend of its
 * task since the moment it began.
 */

export interface SpendLedger {
  /** Money spent since a moment, for everything or for one task. */
  spendSince(since: number, conversationId?: string): number
}

export interface BudgetGuardDeps {
  /** Read on every check, so a change in Settings applies from the next request. */
  settings(): BudgetSettings | undefined
  ledger: SpendLedger
  now?: () => number
}

export interface BudgetVerdict {
  /** A cap with the action `stop` is reached: end the turn before sending the next request. */
  stop: boolean
  notices: BudgetNotice[]
}

export interface SpendSnapshot {
  /** The turn in progress. Undefined when the task is not generating. */
  turn?: number
  /** Everything the task has cost. Undefined when no task is given. */
  session?: number
  /** Everything since local midnight. */
  daily: number
}

interface Turn {
  id: number
  startedAt: number
}

type Finding = Omit<BudgetNotice, 'message'> & { key: string }

export class BudgetGuard {
  /** The turn each task is running now. */
  private readonly turns = new Map<string, Turn>()
  private nextTurn = 1
  /** Warnings already raised, keyed by scope, the thing it was measured over, the cap and the level. */
  private readonly raised = new Set<string>()

  constructor(private readonly deps: BudgetGuardDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  beginTurn(conversationId: string): void {
    this.turns.set(conversationId, { id: this.nextTurn++, startedAt: this.now() })
  }

  endTurn(conversationId: string): void {
    this.turns.delete(conversationId)
    // A turn's warnings belong to that turn alone, and turn ids are never reused.
    for (const key of this.raised) if (key.startsWith(`turn:${conversationId}:`)) this.raised.delete(key)
  }

  forget(conversationId: string): void {
    this.turns.delete(conversationId)
    for (const key of this.raised) if (key.includes(`:${conversationId}:`)) this.raised.delete(key)
  }

  /** Spend of one scope, read from the ledger only when a cap makes it matter. */
  private spent(scope: BudgetScope, conversationId: string): number {
    if (scope === 'turn') {
      const turn = this.turns.get(conversationId)
      return turn ? this.deps.ledger.spendSince(turn.startedAt, conversationId) : 0
    }
    if (scope === 'session') return this.deps.ledger.spendSince(0, conversationId)
    return this.deps.ledger.spendSince(startOfLocalDay(this.now()))
  }

  snapshot(conversationId?: string): SpendSnapshot {
    const turn = conversationId ? this.turns.get(conversationId) : undefined
    return {
      ...(conversationId && turn ? { turn: this.spent('turn', conversationId) } : {}),
      ...(conversationId ? { session: this.spent('session', conversationId) } : {}),
      daily: this.spent('daily', conversationId ?? '')
    }
  }

  /** What the cap is measured over, so a new day, a new turn or a new task raises its warnings afresh. */
  private subject(scope: BudgetScope, conversationId: string): string {
    if (scope === 'daily') return String(startOfLocalDay(this.now()))
    if (scope === 'session') return conversationId
    return `${conversationId}:${this.turns.get(conversationId)?.id ?? 0}`
  }

  /** Each cap that is at 80 percent or more, with the key that makes its warning once per crossing. Raises nothing. */
  private findings(conversationId: string): Finding[] {
    const budget = this.deps.settings()
    const action = budget?.action === 'stop' ? 'stop' : 'warn'
    const found: Finding[] = []
    for (const scope of BUDGET_SCOPES) {
      const limitUsd = budgetLimit(budget, scope)
      if (limitUsd === undefined) continue
      const spentUsd = this.spent(scope, conversationId)
      const state = budgetState(spentUsd, limitUsd)
      if (state === 'ok') continue
      const level = state === 'over' ? 'over' : 'warn'
      found.push({
        scope, level, action, spentUsd, limitUsd, stopped: level === 'over' && action === 'stop',
        key: `${scope}:${this.subject(scope, conversationId)}:${limitUsd}:${level}`
      })
    }
    return found
  }

  check(conversationId: string): BudgetVerdict {
    const notices: BudgetNotice[] = []
    let stop = false
    for (const { key, ...notice } of this.findings(conversationId)) {
      if (notice.stopped) stop = true
      else if (this.raised.has(key)) continue
      else this.raised.add(key)
      notices.push({ ...notice, message: budgetMessage(notice) })
    }
    return { stop, notices }
  }

  /**
   * Why a request cannot go out right now, in the words the person should read, or undefined when it can.
   * For requests made outside a turn (a summary on demand); unlike `check` it raises nothing, so a warning
   * is still shown by the next turn.
   */
  blocker(conversationId: string): string | undefined {
    const reasons = this.findings(conversationId).filter((finding) => finding.stopped).map(({ key: _key, ...notice }) => budgetMessage(notice))
    return reasons.length ? reasons.join(' ') : undefined
  }
}
