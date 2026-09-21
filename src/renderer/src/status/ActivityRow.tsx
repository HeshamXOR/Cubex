import { Brain, Loader2, PenLine, RotateCw, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import type { HarnessState } from './StatusIndicator'
import { formatElapsed, useElapsed } from '../lib/useElapsed'
import './status.css'

const VERB: Partial<Record<HarnessState, { label: string; icon: JSX.Element; spin?: boolean }>> = {
  thinking: { label: 'Thinking', icon: <Brain size={15} /> },
  working: { label: 'Working', icon: <Loader2 size={15} />, spin: true },
  editing: { label: 'Editing', icon: <PenLine size={15} /> },
  streaming: { label: 'Generating', icon: <Sparkles size={15} /> },
  retrying: { label: 'Retrying', icon: <RotateCw size={15} />, spin: true },
  falling_back: { label: 'Falling back', icon: <TriangleAlert size={15} /> },
  running_tool: { label: 'Running tool', icon: <Wrench size={15} />, spin: true }
}

/**
 * The in-thread harness activity block — the animated "Thinking… 4.2s" line
 * shown above the assistant's answer while it works, with a shimmering label,
 * a live elapsed timer, and an optional detail (tool name, fallback target).
 */
export function ActivityRow({
  state,
  startedAt,
  detail
}: {
  state: HarnessState
  startedAt?: number
  detail?: string
}): JSX.Element | null {
  const active = state in VERB
  const elapsed = useElapsed(startedAt, active)
  const spec = VERB[state]
  if (!spec) return null
  return (
    <div className="activity">
      <span className={spec.spin ? 'activity__icon activity__icon--spin' : 'activity__icon'}>{spec.icon}</span>
      <span className="activity__label shimmer">{spec.label}</span>
      {detail && <span className="activity__detail">{detail}</span>}
      <span className="activity__time">{formatElapsed(elapsed)}</span>
    </div>
  )
}
