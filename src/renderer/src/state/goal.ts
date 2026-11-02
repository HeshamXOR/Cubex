import { api } from '../lib/api'
import {
  applyVerdict, goalKickoff, parseGoalCommand, pauseGoal, resumeGoal, startGoal, storableGoal,
  type Goal, type GoalVerdict
} from '../../../shared/goal'
import { conditionsFor, useQueue } from './queue'
import { useCommandNotice } from './commandNotice'
import { useStore } from './store'

/**
 * The loop behind a goal. After every turn of an active goal the window asks the main process whether the goal is
 * met (a check command, or a model reading the record of the turn), then either ends the goal or sends the agent
 * back to work. It lives in the window, like the message queue, because the window stores each turn when it ends:
 * the next turn must start after that, not beside it. A goal continues only while its task is the one on screen,
 * and it is kept with its task, so it comes back paused when Cubex is opened again.
 *
 * What happens to the goal is decided by the pure rules in shared/goal.ts. This file only waits for the right moment
 * and carries the decision out.
 */

type StoreState = ReturnType<typeof useStore.getState>

/**
 * Say what went wrong with a /goal command, above the composer: what happened, and what to do about it. The command is
 * left in the composer to be corrected, not typed again: a changed revision is how the composer knows the draft is
 * still wanted. This is not a turn error, so the status of the task is left alone.
 */
function fail(message: string): void {
  useCommandNotice.getState().show(useStore.getState().activeConversation?.id, message)
  useStore.setState((state) => ({ composerRevision: state.composerRevision + 1 }))
}

/** Replace the goal of the task on screen, when it is still the task the change was meant for. */
function setGoalOf(conversationId: string, goal: Goal | undefined): void {
  if (useStore.getState().activeConversation?.id !== conversationId) return
  useStore.getState().setGoal(goal)
}

/** Why the last turn failed, when the window knows: the detail it was left with, or what the failed reply says. */
function failureOf(state: StoreState): string | undefined {
  const reply = [...state.liveMessages].reverse().find((message) => message.role === 'assistant')
  return state.statusDetail || reply?.error?.message || undefined
}

/** True while a turn runs, a summary is being written, or the turn waits for an answer: nothing may start meanwhile. */
function occupied(state: StoreState, conversationId: string): boolean {
  const conditions = conditionsFor(state, conversationId)
  return conditions.running || conditions.compacting || conditions.needsAnswer
}

/** How many tool calls the agent made in the turn that just ended: what tells a turn that worked from one that did nothing. */
export function toolCallsInLastTurn(state: Pick<StoreState, 'liveMessages'>): number {
  const last = [...state.liveMessages].reverse().find((message) => message.role === 'assistant')
  if (!last) return 0
  const blocks = last.blocks?.filter((block) => block.type === 'tool').length
  return blocks ?? last.toolCalls?.length ?? 0
}

// --- The commands ---------------------------------------------------------------------

/** `/goal`: start a goal and the first turn, or show, pause, resume or clear it. */
export async function handleGoalCommand(rest: string): Promise<void> {
  const command = parseGoalCommand(rest)
  const state = useStore.getState()
  switch (command.kind) {
    case 'invalid':
      return fail(command.error)
    case 'status':
      if (!state.goal) fail('No goal is set. Say what done means, for example: /goal all tests pass --check npm test')
      return
    case 'pause':
      return pauseActiveGoal()
    case 'resume':
      return resumeActiveGoal()
    case 'clear':
      return clearActiveGoal()
    case 'start': {
      if (!state.activeProviderId || !state.activeModel) return fail('Choose a model, then set the goal.')
      let conversation = state.activeConversation
      if (conversation && occupied(state, conversation.id)) return fail('A turn is running. Stop it or wait for it to finish, then set the goal.')
      if (!conversation) {
        // A new session has no task until something is sent, and a goal belongs to a task: the task is made now.
        try {
          conversation = await state.newConversation()
        } catch (cause) {
          return fail(cause instanceof Error && cause.message ? cause.message : 'The task for this goal could not be created. Try again.')
        }
        if (!conversation) return fail('The task for this goal could not be created. Try again.')
      }
      installGoalRunner()
      const goal = startGoal(command.text, command.check, undefined, command.budget)
      useStore.getState().setGoal(goal)
      // The first turn is an ordinary message, so the thread shows what was asked. The composer is left as it is.
      const sent = await useStore.getState().sendMessage(goalKickoff(command.text), { attachments: [] })
      if (!sent) {
        setGoalOf(conversation.id, undefined)
        fail('The goal could not start. Wait for what is running to finish, then try again.')
      }
    }
  }
}

/** Do not start another turn for the goal. A turn already running finishes. */
export function pauseActiveGoal(note?: string): void {
  const state = useStore.getState()
  const goal = state.goal
  const id = state.activeConversation?.id
  if (!goal || !id || goal.status !== 'active') return
  invalidate(id)
  void api.cancelGoalCheck(id).catch(() => undefined)
  state.setGoal(pauseGoal(goal, note))
}

/** Pick a paused, blocked, stalled or limited goal up again with a new turn, or after the running one if there is one. */
export async function resumeActiveGoal(): Promise<void> {
  const state = useStore.getState()
  const goal = state.goal
  const id = state.activeConversation?.id
  if (!goal || !id || goal.status === 'active' || goal.status === 'complete') return
  installGoalRunner()
  if (occupied(state, id)) {
    // The turn that is running is judged when it ends, whoever started it.
    const { note: _note, ...rest } = goal
    state.setGoal({ ...rest, status: 'active', idle: 0, turning: true })
    return
  }
  const step = resumeGoal(goal)
  state.setGoal(step.goal)
  if (!step.send) return
  const sent = await useStore.getState().sendMessage(step.send, { attachments: [] })
  if (!sent) setGoalOf(id, pauseGoal(useStore.getState().goal ?? step.goal, 'The next turn could not start. Choose a model, then resume the goal.'))
}

/** Forget the goal. Judging that is in progress is stopped. */
export function clearActiveGoal(): void {
  const id = useStore.getState().activeConversation?.id
  if (id) {
    invalidate(id)
    void api.cancelGoalCheck(id).catch(() => undefined)
  }
  useStore.getState().setGoal(undefined)
}

// --- The runner -----------------------------------------------------------------------

let installed = false
let scheduled = false
/** The judging each task is waiting on. An answer for any other number is about a goal that has since changed. */
const pending = new Map<string, number>()
let counter = 0

function invalidate(conversationId: string): void {
  pending.delete(conversationId)
}

export function installGoalRunner(): void {
  if (installed) return
  installed = true
  useStore.subscribe(schedule)
  useStore.subscribe(persist)
  useQueue.subscribe(schedule)
}

// --- Keeping the goal with its task -----------------------------------------------------

/** The goal last handed to the database for each task. A goal is saved when it is not the one saved before. */
const saved = new Map<string, Goal | undefined>()
let lastGoal: Goal | undefined
let lastRuns: StoreState['conversationRuns'] | undefined
let lastActive: string | undefined

function save(conversationId: string, goal: Goal | undefined): void {
  // A failure to save must not stop the goal: the next change saves it again.
  void Promise.resolve().then(() => api.setGoal(conversationId, goal ? storableGoal(goal) : null)).catch(() => undefined)
}

/** Save every change to the goal of the task on screen and of the tasks running out of sight. */
function persist(state: StoreState): void {
  const active = state.activeConversation?.id
  if (state.goal === lastGoal && state.conversationRuns === lastRuns && active === lastActive) return
  lastGoal = state.goal
  lastRuns = state.conversationRuns
  lastActive = active
  const now = new Map<string, Goal | undefined>()
  for (const [id, run] of Object.entries(state.conversationRuns)) if (run.activeConversation?.id === id) now.set(id, run.goal)
  if (active) now.set(active, state.goal)
  for (const [id, goal] of now) {
    if (saved.has(id) ? saved.get(id) !== goal : goal !== undefined) save(id, goal)
    saved.set(id, goal)
  }
}

/** Look again once the current update has settled, never in the middle of an event handler. */
function schedule(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    void evaluate()
  })
}

async function evaluate(): Promise<void> {
  const state = useStore.getState()
  const goal = state.goal
  const conversation = state.activeConversation
  if (!goal || !conversation || goal.status !== 'active') return
  if (goal.checking && !pending.has(conversation.id)) {
    // The task was left while its turn was being judged and nothing is waiting for the answer any more: the flag would
    // stay for good. Judge the turn again.
    const { checking: _checking, ...rest } = goal
    void api.cancelGoalCheck(conversation.id).catch(() => undefined)
    state.setGoal({ ...rest, turning: true })
    return
  }
  if (!goal.turning || goal.checking) return
  // Streaming updates the store many times a second: a turn that is still running is the cheap, common answer.
  if (state.streamId || state.startingRequest) return
  const id = conversation.id
  if (occupied(state, id)) return
  const end = conditionsFor(state, id).lastEnd
  if (end === 'stopped') return setGoalOf(id, pauseGoal(goal, 'You stopped the turn.'))
  if (end === 'failed') {
    const why = failureOf(state)
    return setGoalOf(id, pauseGoal(goal, `The turn failed${why ? `: ${why.replace(/[.\s]+$/, '')}` : ''}. Resume the goal when it is fixed.`))
  }
  if (end !== 'completed') return
  // What the person queued while the agent worked is theirs to send first; the goal is judged after those turns.
  if ((useQueue.getState().queues[id]?.length ?? 0) > 0) return

  const token = ++counter
  pending.set(id, token)
  const { claim } = goal
  state.setGoal({ ...goal, checking: true, turning: false })
  let verdict: GoalVerdict
  try {
    verdict = await api.evaluateGoal({
      conversationId: id,
      goal: { text: goal.text, ...(goal.check ? { check: goal.check } : {}) },
      ...(claim ? { claim } : {})
    })
  } catch (cause) {
    verdict = { kind: 'error', reason: cause instanceof Error ? cause.message : 'The goal could not be checked.' }
  }

  // The person may have paused, cleared or steered the goal while it was being judged: that answer is then stale.
  const now = useStore.getState()
  if (pending.get(id) !== token) return
  pending.delete(id)
  if (now.activeConversation?.id !== id) return applyAway(now, id, verdict)
  if (now.goal?.status !== 'active' || !now.goal.checking) return

  const step = applyVerdict(now.goal, verdict, { toolCalls: toolCallsInLastTurn(now) })
  now.setGoal(step.goal)
  if (!step.send) return
  const sent = await useStore.getState().sendMessage(step.send, { attachments: [] })
  if (!sent) setGoalOf(id, pauseGoal(useStore.getState().goal ?? step.goal, 'The next turn could not start. Choose a model, then resume the goal.'))
}

/**
 * The answer came while the person was on another task. It belongs to the goal of that task, which sits in its cached
 * run: it is applied there, so the goal is not left checking. Nothing can be sent to a task that is not on screen, so
 * a goal that is not met yet stops with the reason, and the person picks it up again where it was.
 */
function applyAway(state: StoreState, id: string, verdict: GoalVerdict): void {
  const run = state.conversationRuns[id]
  const goal = run?.goal
  if (!run || !goal || goal.status !== 'active' || !goal.checking) return
  const step = applyVerdict(goal, verdict, { toolCalls: toolCallsInLastTurn(run) })
  if (step.send) {
    const reason = verdict.kind === 'continue' ? verdict.reason.replace(/[.\s]+$/, '') : 'The goal is not met yet'
    state.setGoal(pauseGoal(goal, `${reason}. Resume the goal to continue.`), id)
    return
  }
  state.setGoal(step.goal, id)
}
