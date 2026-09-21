import type { HarnessState } from './StatusIndicator'
import { AnimatedMark, type MarkMotion } from '../theme/AnimatedMark'
import { formatElapsed, useElapsed } from '../lib/useElapsed'
import './status.css'

const LABEL: Partial<Record<HarnessState, string>> = {
  thinking: 'Thinking',
  working: 'Working',
  editing: 'Editing',
  streaming: 'Generating',
  retrying: 'Retrying',
  falling_back: 'Falling back',
  running_tool: 'Running tool'
}

function motionFor(state: HarnessState): MarkMotion {
  if (state === 'streaming') return 'streaming'
  if (state === 'working' || state === 'running_tool' || state === 'editing') return 'working'
  return 'thinking'
}

/**
 * The in-thread harness activity block: the animated Cubex mark, a shimmering
 * verb, an optional detail (tool name / fallback target), and a live timer.
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
  const label = LABEL[state]
  const elapsed = useElapsed(startedAt, !!label)
  if (!label) return null
  return (
    <div className="activity">
      <AnimatedMark size={20} state={motionFor(state)} />
      <span className="activity__label shimmer">{label}</span>
      {detail && <span className="activity__detail">{detail}</span>}
      <span className="activity__time">{formatElapsed(elapsed)}</span>
    </div>
  )
}
