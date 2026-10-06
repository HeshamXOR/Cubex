import { Check, ShieldQuestion } from 'lucide-react'
import type { PermissionMode, TodoItem } from '../../../shared/ipc'
import { useStore } from '../state/store'
import { activitySpecFor } from '../status/StatusIndicator'
import { CubexMark } from '../theme/Logo'

const MODE_NOTE: Record<PermissionMode, string> = {
  default: 'edits ask first',
  acceptEdits: 'edits go through',
  plan: 'read-only',
  bypass: 'nothing asks'
}

/** Backticks in a step become code, the way the model wrote them. */
function Inline({ text }: { text: string }): JSX.Element {
  const parts = text.split(/`([^`]+)`/g)
  return <>{parts.map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>
}

/**
 * The model's checklist, in the thread where it was written. Steps finish top to
 * bottom: done ones get a check, the step being worked on gets the turning star, or
 * the amber shield while it waits for the person. A saved plan opens from its title.
 */
export function TodoPlan({ todos }: { todos: readonly TodoItem[] }): JSX.Element | null {
  const mode = useStore((s) => s.permissionMode)
  const waiting = useStore((s) => !!s.pendingPermission || !!s.pendingQuestion || !!s.pendingPlan)
  const working = useStore((s) => !!activitySpecFor(s.status).active)
  const latestPlan = useStore((s) => s.plans[0])
  const openPlan = useStore((s) => s.openPlan)
  if (!todos.length) return null
  const done = todos.filter((todo) => todo.status === 'completed').length
  const percent = Math.round((done / todos.length) * 100)
  const approved = latestPlan?.status === 'approved'
  return (
    <section className="plan" aria-label="Plan">
      <header>
        {latestPlan
          ? <button className="plan__open" onClick={() => openPlan(latestPlan)} title="Open the saved plan"><b>Plan</b></button>
          : <b>Plan</b>}
        <span>{approved ? 'approved, ' : ''}{MODE_NOTE[mode]}</span>
        <span className="prog" aria-label={`${done} of ${todos.length} steps done`}>
          {done} of {todos.length}
          <span className="bar"><i style={{ width: `${percent}%` }} /></span>
        </span>
      </header>
      <ol>
        {todos.map((todo, index) => {
          const current = todo.status === 'in_progress'
          return (
            <li key={index} className={todo.status === 'completed' ? 'done' : current ? 'cur' : ''} aria-current={current ? 'step' : undefined}>
              {todo.status === 'completed' && <Check size={12} strokeWidth={2.4} className="li-mark li-mark--done" aria-hidden="true" />}
              {current && (waiting
                ? <ShieldQuestion size={14} className="li-mark li-mark--wait" aria-hidden="true" />
                : <CubexMark size={12} className={`li-mark li-mark--cur mark ${working ? 'turning' : ''}`} />)}
              <Inline text={current && todo.activeForm ? todo.activeForm : todo.content} />
            </li>
          )
        })}
      </ol>
    </section>
  )
}
