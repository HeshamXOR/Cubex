import { Target } from 'lucide-react'
import { goalCheckTitle } from '../../lib/goalText'
import type { GoalMessage } from '../../../../shared/goal'
import './goal.css'

/**
 * Where Cubex sent the agent back to work because the goal was not met yet, with the reason. It stands where your
 * own message would, since it is a message in the thread, but it is not yours and cannot be edited or deleted.
 */
export function GoalCheckRow({ message }: { message: GoalMessage }): JSX.Element {
  const title = goalCheckTitle(message.turn, message.of)
  return (
    <section className="goalcheck" aria-label={title} data-message="goal-check">
      <div className="goalcheck__row">
        <Target size={14} aria-hidden="true" />
        <span className="goalcheck__label">{title}</span>
      </div>
      {message.reason && <p className="goalcheck__note">{message.reason}</p>}
    </section>
  )
}
