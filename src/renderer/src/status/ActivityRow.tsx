import { activitySpecFor, StateIcon, type HarnessState } from './StatusIndicator'
import { formatElapsed, useElapsed } from '../lib/useElapsed'
import './status.css'

/** An operation label, its matching glyph, and the actual turn elapsed time. */
export function ActivityRow({ state, startedAt, detail, label, iconSize = 18 }: {
  state: HarnessState
  startedAt?: number
  detail?: string
  label?: string
  iconSize?: number
}): JSX.Element | null {
  const spec = activitySpecFor(state)
  const elapsed = useElapsed(startedAt, !!spec.active)
  if (!spec.active && state !== 'awaiting_input') return null
  return (
    <div className={`activity activity--${spec.tone}`} data-state={state} role="status" aria-live="polite">
      <span className="activity__icon"><StateIcon state={state} size={iconSize} /></span>
      <span className={`activity__label ${spec.active ? 'is-shimmer' : ''}`}>{label ?? spec.label}</span>
      {detail && <span className="activity__detail" title={detail}>{detail}</span>}
      {spec.active && startedAt !== undefined && <span className="activity__time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
    </div>
  )
}
