import { goalContinuation, goalKickoff, startGoal, withNote, type Goal } from '../../../../shared/goal'
import type { LiveMessage } from '../../state/store'
import type { PreviewSeed } from './index'

/**
 * A goal for the browser preview. Every flag rides on `done=1` or `thread=1`, which open the session the goal belongs to.
 *
 *   ?seed=1&done=1&goal=working     a goal on its second turn, with the agent at work
 *     goal=checking                 the last turn is being judged
 *     goal=idle                     between turns: the next one is about to start
 *     goal=paused | blocked | stalled | limit | complete
 *     goalcheck=none                no check command on the goal
 *     goalthread=1                  a thread that shows the goal's first message and the divider where the agent was sent back to work
 */

const GOAL_TEXT = 'All tests in packages/api pass'
const CHECK = 'npm test --workspace packages/api'
const MINUTE = 60_000

const FAILED_CHECK = 'The check failed with exit code 1: npm test --workspace packages/api'

function goalFor(flag: string, withCheck: boolean): Goal | undefined {
  const base = startGoal(GOAL_TEXT, withCheck ? CHECK : undefined, 15)
  switch (flag) {
    case 'working': return withNote({ ...base, turns: 2, turning: true }, FAILED_CHECK)
    case 'idle': return withNote({ ...base, turns: 3 }, FAILED_CHECK)
    case 'checking': return { ...base, turns: 2, checking: true }
    case 'paused': return withNote({ ...base, turns: 2, status: 'paused' }, 'You stopped the turn.')
    case 'blocked': return withNote({ ...base, turns: 3, status: 'blocked' }, 'Needs the staging database URL, which is not in the environment or the project.')
    case 'stalled': return withNote({ ...base, turns: 4, status: 'stalled', idle: 2 }, 'Two turns in a row did no work and did not say what is missing.')
    case 'limit': return withNote({ ...base, turns: 15, status: 'limit' }, 'Stopped after 15 turns. The check failed with exit code 1: npm test --workspace packages/api')
    case 'complete': return withNote({ ...base, turns: 3, status: 'complete' }, withCheck ? `The check passed: ${CHECK}` : 'The record of the turn shows the tests ran and all 48 passed.')
    default: return undefined
  }
}

const reply = (id: string, text: string, createdAt: number, tools = 0): LiveMessage => ({
  id, role: 'assistant', text, createdAt,
  blocks: [
    ...Array.from({ length: tools }, (_, index) => ({
      type: 'tool' as const,
      tool: { id: `${id}-t${index}`, name: 'run_command', phase: 'done' as const, title: index === 0 ? 'Run npm test --workspace packages/api' : 'Edit src/routes/upload.ts' }
    })),
    { type: 'text' as const, text }
  ]
})

function goalThread(now: number): LiveMessage[] {
  return [
    { id: 'g-u1', role: 'user', text: goalKickoff(GOAL_TEXT), createdAt: now - 12 * MINUTE },
    reply('g-a1', 'I ran the API tests. Two fail: the upload route returns 500 for an empty body, and the retry test times out. I fixed the route and left the retry test for the next pass.', now - 10 * MINUTE, 3),
    { id: 'g-u2', role: 'user', text: goalContinuation(2, 15, FAILED_CHECK, 'Output of the check, which is the end of what it printed:\nFAIL packages/api/src/retry.test.ts\n  retries on 429 > waits for Retry-After\n  Error: Test timed out in 5000ms'), createdAt: now - 9 * MINUTE },
    reply('g-a2', 'The retry test waited for a real clock. I switched it to fake timers and the delay now advances without waiting. All 48 tests pass.', now - 6 * MINUTE, 2)
  ]
}

export const seed: PreviewSeed = {
  state: (flags) => {
    const flag = flags.get('goal')
    if (flag === null && !flags.has('goalthread')) return undefined
    const state: Record<string, unknown> = {}
    const goal = flag ? goalFor(flag, flags.get('goalcheck') !== 'none') : undefined
    if (goal) Object.assign(state, { goal })
    if (flags.has('goalthread')) Object.assign(state, { liveMessages: goalThread(Date.now()), todos: [] })
    if (flag === 'working') Object.assign(state, { status: 'running_tool', statusDetail: undefined, streamId: 'seed-stream', genStartedAt: Date.now() - 30_000 })
    else if (goal) Object.assign(state, { status: 'done', streamId: undefined })
    return state
  }
}
