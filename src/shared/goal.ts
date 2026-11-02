/**
 * Goals. The person says what "done" means, and Cubex keeps the agent working, turn after turn, until the goal is met,
 * the agent says it cannot go on without them, or a limit is reached. Pure on purpose: the window decides what happens
 * after each turn with these rules, and the main process only judges whether the goal is met.
 */

/** The tool the model calls to say where the goal stands. Offered only while a goal is active. */
export const GOAL_TOOL = 'goal_update'

export type GoalStatus =
  /** The agent is working on it, or the next turn is about to start. */
  | 'active'
  /** Stopped by the person, or by an error. Nothing runs until they resume. */
  | 'paused'
  | 'complete'
  /** The agent says it needs something from the person. */
  | 'blocked'
  /** Two turns in a row ended with no work and no word on the goal. */
  | 'stalled'
  /** The turn limit or a spending cap was reached. */
  | 'limit'

/** What the agent said about the goal with `goal_update` during a turn. */
export interface GoalClaim {
  status: 'complete' | 'blocked'
  /** For complete, what it ran and what that showed. For blocked, what it needs. */
  note: string
}

export interface Goal {
  /** What done means, in the person's words. */
  text: string
  /** A command Cubex runs after each turn: exit code 0 means the goal is met. Optional. */
  check?: string
  status: GoalStatus
  /** Turns spent on the goal, the first one included. */
  turns: number
  maxTurns: number
  /** Turns in a row that did no work and said nothing about the goal. */
  idle: number
  /** What the agent said during the turn that just ended. */
  claim?: GoalClaim
  /** The latest reason, shown under the goal. */
  note?: string
  /** The last turn is being judged. */
  checking?: boolean
  /** A turn for this goal has started and has not been judged yet. */
  turning?: boolean
  /** The most input plus output tokens the turns of this goal may use. Optional. */
  budget?: number
  /** Input plus output tokens used by the turns run for this goal so far. */
  tokens?: number
}

export const GOAL_LIMITS = {
  text: 2_000,
  check: 1_000,
  /** One sentence shown under the goal. */
  note: 1_500,
  /** What a failed check printed, as far as the agent is shown it. */
  detail: 4_000,
  turns: { min: 1, max: 50, default: 15 },
  budget: { min: 1_000, max: 1_000_000_000 }
} as const

/** How many turns in a row may end without work or a word before the goal is called stalled. */
export const GOAL_IDLE_LIMIT = 2

// --- The /goal command -------------------------------------------------------------

export type GoalCommand =
  /** `/goal` alone: show where the goal stands. */
  | { kind: 'status' }
  | { kind: 'start'; text: string; check?: string; budget?: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'invalid'; error: string }

const CONTROL = /[\u0000-\u001f\u007f]/
const EXAMPLE = 'For example: /goal all tests pass --check npm test'
const BUDGET_EXAMPLE = 'For example: /goal all tests pass --budget 200k --check npm test'

/** A token count as typed: 200000, 200k, 1.5m. Undefined when it is not one. */
export function parseTokenCount(word: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(word.trim())
  if (!match) return undefined
  const scale = match[2] ? (match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1
  return Math.round(Number(match[1]) * scale)
}

/** A token count for people: 950, 1.5k, 38k, 1.2m. */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(count))
  const trim = (value: number): string => String(Math.round(value * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${trim(n / 1_000)}k`
  if (n < 999_500) return `${Math.round(n / 1_000)}k`
  return `${trim(n / 1_000_000)}m`
}

/**
 * Read what follows `/goal`. A word of its own (pause, resume, clear) is a control; anything else is the goal.
 * `--check` ends the goal text and starts a command, so the words of a goal can never be mistaken for one.
 */
export function parseGoalCommand(rest: string): GoalCommand {
  const input = rest.trim()
  if (!input) return { kind: 'status' }
  const word = input.toLowerCase()
  if (word === 'pause') return { kind: 'pause' }
  if (word === 'resume') return { kind: 'resume' }
  if (word === 'clear') return { kind: 'clear' }

  const flag = input.search(/(^|\s)--check(\s|$)/)
  let head = flag >= 0 ? input.slice(0, flag) : input
  let check = flag >= 0 ? input.slice(flag).replace(/^\s*--check\s*/, '').trim() : undefined

  // --budget stands before --check, or last on the line after the command.
  let budgetWord: string | undefined
  const inHead = /(^|\s)--budget(?:\s+(\S+))?(?=\s|$)/.exec(head)
  if (inHead) {
    if (!inHead[2]) return { kind: 'invalid', error: `Give a number of tokens after --budget. ${BUDGET_EXAMPLE}` }
    budgetWord = inHead[2]
    head = `${head.slice(0, inHead.index)} ${head.slice(inHead.index + inHead[0].length)}`.replace(/\s{2,}/g, ' ')
  } else if (check !== undefined) {
    const trailing = /(?:^|\s)--budget\s+(\S+)$/.exec(check)
    if (trailing) {
      budgetWord = trailing[1]
      check = check.slice(0, trailing.index).trim()
    }
  }
  const text = head.trim()
  if (!text) return { kind: 'invalid', error: `Say what done means before --check or --budget. ${EXAMPLE}` }
  if (text.length > GOAL_LIMITS.text) return { kind: 'invalid', error: `The goal is ${text.length.toLocaleString('en-US')} characters. Keep it to ${GOAL_LIMITS.text.toLocaleString('en-US')} or fewer.` }
  if (check !== undefined) {
    if (!check) return { kind: 'invalid', error: `Name the command after --check. ${EXAMPLE}` }
    if (check.length > GOAL_LIMITS.check) return { kind: 'invalid', error: `The check command is ${check.length.toLocaleString('en-US')} characters. Keep it to ${GOAL_LIMITS.check.toLocaleString('en-US')} or fewer.` }
    if (CONTROL.test(check)) return { kind: 'invalid', error: 'The check command must be one line.' }
  }
  let budget: number | undefined
  if (budgetWord !== undefined) {
    budget = parseTokenCount(budgetWord)
    if (budget === undefined) return { kind: 'invalid', error: `"${budgetWord.slice(0, 40)}" is not a token count. Use a number such as 200000, 200k or 1.5m.` }
    if (budget < GOAL_LIMITS.budget.min || budget > GOAL_LIMITS.budget.max) {
      return { kind: 'invalid', error: `The token budget must be between ${GOAL_LIMITS.budget.min.toLocaleString('en-US')} and ${GOAL_LIMITS.budget.max.toLocaleString('en-US')}. ${BUDGET_EXAMPLE}` }
    }
  }
  return { kind: 'start', text, ...(check ? { check } : {}), ...(budget !== undefined ? { budget } : {}) }
}

/** The goal as the main process reads it from the window: bounded text, or nothing when it is not a goal. */
export function normalizeGoalRequest(value: unknown): { text: string; check?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { text, check } = value as { text?: unknown; check?: unknown }
  if (typeof text !== 'string' || !text.trim() || text.length > GOAL_LIMITS.text) return undefined
  const command = typeof check === 'string' ? check.trim() : ''
  if (command && (command.length > GOAL_LIMITS.check || CONTROL.test(command))) return { text: text.trim() }
  return { text: text.trim(), ...(command ? { check: command } : {}) }
}

// --- State -------------------------------------------------------------------------

export function startGoal(text: string, check: string | undefined, maxTurns: number = GOAL_LIMITS.turns.default, budget?: number): Goal {
  return {
    text, ...(check ? { check } : {}), status: 'active', turns: 1, maxTurns: clampTurns(maxTurns), idle: 0,
    ...(budget !== undefined ? { budget } : {})
  }
}

/** Add the tokens a turn used to the goal. */
export function addGoalTokens(goal: Goal, tokens: number): Goal {
  return tokens > 0 ? { ...goal, tokens: (goal.tokens ?? 0) + Math.round(tokens) } : goal
}

/** True once the turns of the goal have used more than its budget. */
export function overBudget(goal: Goal): boolean {
  return goal.budget !== undefined && (goal.tokens ?? 0) > goal.budget
}

/** The input plus output tokens a provider reported for one request. */
export function usageTokens(usage: { inputTokens?: number; outputTokens?: number } | undefined): number {
  return Math.max(0, usage?.inputTokens ?? 0) + Math.max(0, usage?.outputTokens ?? 0)
}

export function clampTurns(value: number): number {
  if (!Number.isFinite(value)) return GOAL_LIMITS.turns.default
  return Math.min(GOAL_LIMITS.turns.max, Math.max(GOAL_LIMITS.turns.min, Math.round(value)))
}

/** The goal without what belongs to one turn only. */
function settled(goal: Goal): Goal {
  const { claim: _claim, checking: _checking, turning: _turning, ...rest } = goal
  return rest
}

/** A sentence for the thread: one line, and not longer than the note allows. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim().slice(0, GOAL_LIMITS.note)
}

export function withNote(goal: Goal, note: string | undefined): Goal {
  const { note: _note, ...rest } = goal
  const line = note ? oneLine(note) : ''
  return line ? { ...rest, note: line } : rest
}

/** The goal after the person pauses it. */
export function pauseGoal(goal: Goal, note = 'No more turns start until you resume.'): Goal {
  return withNote({ ...settled(goal), status: 'paused' }, note)
}

export interface GoalStep {
  goal: Goal
  /** The message that sends the agent back to work, when the goal goes on. */
  send?: string
}

/**
 * Resume a goal: it is active again and the agent gets a message right away. A goal that stopped at its turn limit
 * gets another full allowance, counted from where it stopped.
 */
export function resumeGoal(goal: Goal): GoalStep {
  if (goal.status === 'complete') return { goal }
  const maxTurns = goal.status === 'limit' ? clampTurns(goal.turns + GOAL_LIMITS.turns.default) : goal.maxTurns
  // A goal that spent its budget gets another one of the same size, counted from where it stopped.
  const budget = goal.status === 'limit' && goal.budget !== undefined && overBudget(goal)
    ? Math.min(GOAL_LIMITS.budget.max, (goal.tokens ?? 0) + goal.budget)
    : goal.budget
  const next: Goal = withNote({
    ...settled(goal), status: 'active', idle: 0, turns: goal.turns + 1, maxTurns, ...(budget !== undefined ? { budget } : {})
  }, undefined)
  return { goal: next, send: goalContinuation(next.turns, next.maxTurns, 'You resumed the goal.') }
}

/** What the main process found when it judged the turn that just ended. */
export type GoalVerdict =
  | { kind: 'met'; reason: string }
  /** Not met yet. `detail` is what the agent needs to see, such as the output of a check that failed. */
  | { kind: 'continue'; reason: string; detail?: string }
  | { kind: 'blocked'; reason: string }
  /** A spending cap was reached. */
  | { kind: 'limit'; reason: string }
  /** The turn could not be judged: the check did not start, or the model that judges did not answer. */
  | { kind: 'error'; reason: string }

/** What the window knows about the turn that is not in the verdict. */
export interface GoalTurnFacts {
  /** How many tool calls the agent made in the turn. */
  toolCalls: number
}

/** The goal after a turn was judged, and the message to send when it goes on. */
export function applyVerdict(goal: Goal, verdict: GoalVerdict, facts: GoalTurnFacts): GoalStep {
  const base = settled(goal)
  const reason = oneLine(verdict.reason)
  switch (verdict.kind) {
    case 'met': return { goal: withNote({ ...base, status: 'complete', idle: 0 }, reason) }
    case 'blocked': return { goal: withNote({ ...base, status: 'blocked' }, reason) }
    case 'limit': return { goal: withNote({ ...base, status: 'limit' }, reason) }
    case 'error': return { goal: withNote({ ...base, status: 'paused' }, reason) }
    case 'continue': {
      // A turn with no tool call and no word on the goal did nothing. Twice in a row, asking again will not help.
      const idle = facts.toolCalls === 0 && goal.claim === undefined ? goal.idle + 1 : 0
      if (overBudget(goal) && goal.budget !== undefined) {
        return { goal: withNote({ ...base, status: 'limit', idle }, `Used ${formatTokens(goal.tokens ?? 0)} of the ${formatTokens(goal.budget)} token budget.`) }
      }
      if (goal.turns >= goal.maxTurns) {
        return { goal: withNote({ ...base, status: 'limit', idle }, `Stopped after ${goal.turns} ${goal.turns === 1 ? 'turn' : 'turns'}. ${reason}`) }
      }
      if (idle >= GOAL_IDLE_LIMIT) {
        return { goal: withNote({ ...base, status: 'stalled', idle }, 'Two turns in a row did no work and did not say what is missing.') }
      }
      const next: Goal = withNote({ ...base, status: 'active', idle, turns: goal.turns + 1 }, reason)
      return { goal: next, send: goalContinuation(next.turns, next.maxTurns, reason, verdict.detail) }
    }
  }
}

// --- The messages ------------------------------------------------------------------

/** What the person's first message of a goal says. It is an ordinary message in the thread. */
export function goalKickoff(text: string): string {
  return `Goal: ${text}`
}

const CHECK_OPEN = /^<goal_check turn="(\d+)" of="(\d+)">\n/
const CHECK_CLOSE = '\n</goal_check>'

/**
 * The message that sends the agent back to work. It is wrapped in a tag so the thread can show it as a divider with the
 * reason, and so the agent can tell it came from Cubex and not from the person.
 */
export function goalContinuation(turn: number, of: number, reason: string, detail?: string): string {
  const shown = detail?.trim().slice(0, GOAL_LIMITS.detail)
  return `<goal_check turn="${turn}" of="${of}">\n${oneLine(reason)}\n\n${shown ? `${shown}\n\n` : ''}` +
    'Keep working toward the goal. When it is met, check it, then call goal_update with status "complete" and what you ran and what it showed. ' +
    `If you cannot go on without the person, call goal_update with status "blocked" and say what you need.${CHECK_CLOSE}`
}

export interface GoalMessage {
  turn: number
  of: number
  /** Why the goal is not met yet, or what happened, in a sentence. */
  reason: string
}

/** Read a message back: undefined when it is not one Cubex sent for a goal. */
export function parseGoalMessage(text: string): GoalMessage | undefined {
  const open = CHECK_OPEN.exec(text)
  if (!open || !text.endsWith(CHECK_CLOSE)) return undefined
  const body = text.slice(open[0].length, text.length - CHECK_CLOSE.length)
  const reason = (body.split('\n\n')[0] ?? '').trim()
  return { turn: Number(open[1]), of: Number(open[2]), reason }
}

// --- What the agent is told --------------------------------------------------------

/** The part of the system prompt that explains the goal, written for the model. */
export function goalPrompt(goal: { text: string; check?: string }): string {
  return [
    '## Goal',
    `The person set a goal for this session: ${goal.text}`,
    'Keep working until it is met, across as many turns as it takes. Do not stop to ask whether to continue.',
    `When you believe it is met, check it with the project's own tools (tests, build, lint) instead of assuming, then call ${GOAL_TOOL} with status "complete" and a note saying what you ran and what it showed. ` +
      `Do not call it while any part of the goal is unmet.`,
    goal.check
      ? `Cubex also runs this command after every turn: ${goal.check}\nThe goal is met when it exits with code 0, so make it pass, and do not edit it or work around it.`
      : '',
    `If you cannot go on without the person (a missing decision, access or credentials), call ${GOAL_TOOL} with status "blocked" and say exactly what you need.`,
    'A message wrapped in <goal_check> comes from Cubex, not from the person: the goal is not met yet, so continue from where you stopped.'
  ].filter(Boolean).join('\n')
}

// --- Asking the main process to judge ----------------------------------------------

export interface GoalEvaluateRequest {
  conversationId: string
  goal: { text: string; check?: string }
  claim?: GoalClaim
}

/** The request as main reads it from the window. Throws a sentence the window can show when it is not one. */
export function parseGoalEvaluateRequest(value: unknown): GoalEvaluateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid goal request.')
  const { conversationId, goal, claim } = value as { conversationId?: unknown; goal?: unknown; claim?: unknown }
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) throw new Error('Invalid task id.')
  const normalized = normalizeGoalRequest(goal)
  if (!normalized) throw new Error('The goal is empty or too long.')
  let parsedClaim: GoalClaim | undefined
  if (claim !== undefined && claim !== null) {
    const { status, note } = claim as { status?: unknown; note?: unknown }
    if ((status !== 'complete' && status !== 'blocked') || typeof note !== 'string') throw new Error('Invalid goal claim.')
    parsedClaim = { status, note: note.slice(0, GOAL_LIMITS.note) }
  }
  return { conversationId, goal: normalized, ...(parsedClaim ? { claim: parsedClaim } : {}) }
}

// --- Keeping a goal with its conversation ------------------------------------------

/** The goal as it is stored: without what belongs to the turn that is running. */
export function storableGoal(goal: Goal): Goal {
  return settled(goal)
}

const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'complete', 'blocked', 'stalled', 'limit']
const whole = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined

/** A stored goal read back. The database is not trusted: anything that is not a goal gives undefined. */
export function normalizeStoredGoal(value: unknown): Goal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const request = normalizeGoalRequest({ text: raw.text, check: raw.check })
  if (!request) return undefined
  const status = STATUSES.find((candidate) => candidate === raw.status)
  if (!status) return undefined
  const budget = whole(raw.budget, GOAL_LIMITS.budget.min, GOAL_LIMITS.budget.max)
  const note = typeof raw.note === 'string' ? oneLine(raw.note) : ''
  return {
    text: request.text,
    ...(request.check ? { check: request.check } : {}),
    status,
    turns: whole(raw.turns, 1, 1_000) ?? 1,
    maxTurns: clampTurns(typeof raw.maxTurns === 'number' ? raw.maxTurns : GOAL_LIMITS.turns.default),
    idle: whole(raw.idle, 0, 1_000) ?? 0,
    ...(note ? { note } : {}),
    ...(budget !== undefined ? { budget } : {}),
    tokens: whole(raw.tokens, 0, Number.MAX_SAFE_INTEGER) ?? 0
  }
}

export const RESTART_NOTE = 'Cubex restarted. Resume the goal to continue.'

/**
 * A stored goal as it comes back when its task is opened after Cubex was closed. Nothing was running, so a goal that
 * was working or paused is paused with a note, and nothing starts, the check command included, until the person resumes.
 * A goal that had stopped for another reason keeps that reason.
 */
export function restoreGoal(goal: Goal): Goal {
  if (goal.status !== 'active' && goal.status !== 'paused') return settled(goal)
  return withNote({ ...settled(goal), status: 'paused' }, RESTART_NOTE)
}
