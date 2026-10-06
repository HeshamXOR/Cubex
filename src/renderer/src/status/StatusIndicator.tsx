import { Check, Circle, CircleSlash, RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { ActivityGlyph, type ActivityGlyphKind } from '../theme/StateIcons'
import { formatElapsed, useElapsed } from '../lib/useElapsed'
import './status.css'

export type HarnessState =
  | 'idle' | 'thinking' | 'working' | 'planning' | 'editing' | 'removing'
  | 'streaming' | 'retrying' | 'falling_back' | 'running_tool' | 'preparing_tool'
  | 'awaiting_input' | 'done' | 'error' | 'cancelled'

interface ActivitySpec {
  label: string
  glyph?: ActivityGlyphKind
  icon?: LucideIcon
  active?: boolean
  tone: 'accent' | 'warn' | 'ok' | 'err' | 'mute'
}

const SPECS: Record<HarnessState, ActivitySpec> = {
  idle: { label: 'Ready', icon: Circle, tone: 'mute' },
  thinking: { label: 'Thinking', glyph: 'thinking', active: true, tone: 'accent' },
  working: { label: 'Working', glyph: 'thinking', active: true, tone: 'accent' },
  planning: { label: 'Planning', glyph: 'planning', active: true, tone: 'accent' },
  editing: { label: 'Editing', glyph: 'editing', active: true, tone: 'accent' },
  removing: { label: 'Removing', glyph: 'removing', active: true, tone: 'err' },
  streaming: { label: 'Writing response', glyph: 'writing', active: true, tone: 'accent' },
  retrying: { label: 'Retrying', icon: RotateCw, active: true, tone: 'warn' },
  falling_back: { label: 'Switching provider', icon: RotateCw, active: true, tone: 'warn' },
  running_tool: { label: 'Running tool', glyph: 'running', active: true, tone: 'accent' },
  preparing_tool: { label: 'Preparing tool', glyph: 'thinking', active: true, tone: 'accent' },
  awaiting_input: { label: 'Needs your input', glyph: 'waiting', tone: 'warn' },
  done: { label: 'Done', icon: Check, tone: 'ok' },
  error: { label: 'Error', icon: TriangleAlert, tone: 'err' },
  cancelled: { label: 'Stopped', icon: CircleSlash, tone: 'mute' }
}

export function activitySpecFor(state: HarnessState): ActivitySpec {
  return SPECS[state]
}

export function StateIcon({ state, size = 15 }: { state: HarnessState; size?: number }): JSX.Element {
  const spec = SPECS[state]
  if (spec.glyph) return <ActivityGlyph kind={spec.glyph} size={size} active={spec.active} />
  const Icon = spec.icon ?? Circle
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
}

/** Inline status for conversational surfaces; application chrome stays quiet. */
export function StatusIndicator({ state, detail, startedAt }: {
  state: HarnessState
  detail?: string
  startedAt?: number
}): JSX.Element | null {
  const spec = SPECS[state]
  const elapsed = useElapsed(startedAt, !!spec.active)
  if (state === 'idle') return null
  return (
    <span className={`status status--${spec.tone}`} data-state={state} role="status" aria-live="polite" aria-atomic="true">
      <span className="status__icon"><StateIcon state={state} /></span>
      <span className="status__label">{spec.label}</span>
      {detail && <span className="status__detail" title={detail}>{detail}</span>}
      {spec.active && startedAt !== undefined && <span className="status__time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
    </span>
  )
}
