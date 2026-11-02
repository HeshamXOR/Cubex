import { formatTokens, type Goal } from '../../../shared/goal'

/**
 * Words for a goal in the window: what the bar above the composer says about where it stands, and the divider the
 * thread shows where Cubex sent the agent back to work. Plain sentences, no symbols, so a screen reader reads them as
 * they are.
 */

export interface GoalLook {
  /** The first line: the state of the goal. */
  headline: string
  /** The reason behind it: the latest note, when there is one. */
  detail?: string
}

const turnsWord = (count: number): string => `${count} ${count === 1 ? 'turn' : 'turns'}`

/** What the bar says. `running` is true while a turn of this task is generating. */
export function describeGoal(goal: Goal, running: boolean): GoalLook {
  const note = goal.note
  switch (goal.status) {
    case 'active':
      if (goal.checking) return { headline: 'Checking whether the goal is met.', ...(goal.check ? { detail: `Running ${goal.check}` } : {}) }
      if (running || goal.turning) return { headline: `Working on it. Turn ${goal.turns} of ${goal.maxTurns}.`, ...(note ? { detail: note } : {}) }
      return { headline: `Starting turn ${goal.turns} of ${goal.maxTurns}.`, ...(note ? { detail: note } : {}) }
    case 'paused':
      return { headline: 'Paused.', ...(note ? { detail: note } : {}) }
    case 'complete':
      return { headline: `Done after ${turnsWord(goal.turns)}.`, ...(note ? { detail: note } : {}) }
    case 'blocked':
      return { headline: 'The agent needs something from you.', ...(note ? { detail: note } : {}) }
    case 'stalled':
      return { headline: 'The agent stopped without finishing.', ...(note ? { detail: note } : {}) }
    case 'limit':
      return { headline: 'The goal reached a limit.', ...(note ? { detail: note } : {}) }
  }
}

/** What the goal has used of its token budget: "38k of 200k tokens". Undefined when it has no budget. */
export function describeBudget(goal: Goal): string | undefined {
  return goal.budget === undefined ? undefined : `${formatTokens(goal.tokens ?? 0)} of ${formatTokens(goal.budget)} tokens`
}

/** The button that picks a stopped goal up again, or undefined when the goal is running or done. */
export function resumeLabel(goal: Goal): string | undefined {
  switch (goal.status) {
    case 'paused': return 'Resume'
    case 'blocked': return 'Continue'
    case 'stalled': return 'Try again'
    case 'limit': return 'Keep going'
    default: return undefined
  }
}

/** The divider where Cubex sent the agent back to work: "Goal check 3 of 15". */
export function goalCheckTitle(turn: number, of: number): string {
  return `Goal check, turn ${turn} of ${of}`
}
