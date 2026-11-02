import { CircleCheck, CirclePause, Target, TriangleAlert, X } from 'lucide-react'
import { CubexMark } from '../../theme/Logo'
import { describeBudget, describeGoal, resumeLabel } from '../../lib/goalText'
import { clearActiveGoal, pauseActiveGoal, resumeActiveGoal } from '../../state/goal'
import { useStore } from '../../state/store'
import type { Goal } from '../../../../shared/goal'
import './goal.css'

/** Working shows the turning star, a goal that needs the person shows the amber mark the rest of the app uses. */
function GoalIcon({ goal, running }: { goal: Goal; running: boolean }): JSX.Element {
  if (goal.status === 'active') {
    return running || goal.checking || goal.turning
      ? <CubexMark size={13} className="goalbar__icon turning" />
      : <Target size={14} className="goalbar__icon" aria-hidden="true" />
  }
  if (goal.status === 'complete') return <CircleCheck size={14} className="goalbar__icon" aria-hidden="true" />
  if (goal.status === 'paused') return <CirclePause size={14} className="goalbar__icon" aria-hidden="true" />
  return <TriangleAlert size={14} className="goalbar__icon goalbar__icon--attention" aria-hidden="true" />
}

/**
 * The goal of this task, above the composer: what it is, where it stands and why, and the one thing to do next.
 * The loop that judges each turn and sends the next one is in state/goal.ts.
 */
export function GoalBar(): JSX.Element | null {
  const goal = useStore((state) => state.goal)
  const running = useStore((state) => !!state.streamId || state.liveMessages.some((message) => message.streaming))
  if (!goal) return null
  const look = describeGoal(goal, running)
  const resume = resumeLabel(goal)
  const budget = describeBudget(goal)
  const attention = goal.status === 'blocked' || goal.status === 'stalled' || goal.status === 'limit'

  return (
    <section className={`goalbar ${attention ? 'goalbar--attention' : ''}`} aria-label="Goal">
      <div className="goalbar__head">
        <span className="goalbar__title"><GoalIcon goal={goal} running={running} />Goal</span>
        <span className="goalbar__text" title={goal.text.slice(0, 600)}>{goal.text}</span>
        <span className="goalbar__actions">
          {goal.status === 'active' && <button className="btn ghost sm" onClick={() => pauseActiveGoal()}>Pause</button>}
          {resume && <button className="btn pri sm" onClick={() => void resumeActiveGoal()}>{resume}</button>}
          <button className="goalbar__x" onClick={clearActiveGoal} aria-label="Clear goal" title="Clear goal"><X size={13} /></button>
        </span>
      </div>
      <p className="goalbar__state" role="status">
        {look.headline}
        {look.detail && <span className="goalbar__detail"> {look.detail}</span>}
      </p>
      {budget && <p className="goalbar__budget"><span>Budget</span> {budget}</p>}
      {goal.check && <p className="goalbar__check"><span>Check</span> <code>{goal.check}</code></p>}
    </section>
  )
}
