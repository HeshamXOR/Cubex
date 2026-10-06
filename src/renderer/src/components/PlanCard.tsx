import { ArrowUpRight, FileText } from 'lucide-react'
import type { PlanAsk } from '../../../shared/ipc'
import { planFileName, planStatusLabel, planTitle } from './planPresentation'
import './plan.css'

/** A plan stays in the conversation as a file; review happens in its own pane. */
export function PlanCard({
  ask,
  onOpen,
  pending = false
}: {
  ask: PlanAsk
  onOpen: () => void
  pending?: boolean
}): JSX.Element {
  return (
    <button className="plan-artifact" onClick={onOpen} aria-label={`Open plan: ${planTitle(ask)}`}>
      <FileText size={21} strokeWidth={1.5} className="plan-artifact__icon" />
      <span className="plan-artifact__body">
        <span className="plan-artifact__file">{planFileName(ask)}</span>
        <span className="plan-artifact__description">{planTitle(ask)}</span>
      </span>
      <span className={`plan-artifact__status ${pending ? 'is-pending' : ''}`}>
        {planStatusLabel(ask, pending)}
      </span>
      <ArrowUpRight size={16} className="plan-artifact__open" />
    </button>
  )
}
