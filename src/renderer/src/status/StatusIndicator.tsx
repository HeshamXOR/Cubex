import { Brain, Check, CircleSlash, Loader2, PenLine, RotateCw, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import { formatElapsed, useElapsed } from '../lib/useElapsed'
import './status.css'

/**
 * Activity states surfaced during a request lifecycle — the "thinking /
 * working / editing" affordances of a real agent harness.
 */
export type HarnessState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'editing'
  | 'streaming'
  | 'retrying'
  | 'falling_back'
  | 'running_tool'
  | 'done'
  | 'error'
  | 'cancelled'

interface Spec {
  label: string
  icon: JSX.Element
  spin?: boolean
  tone?: 'accent' | 'warn' | 'ok' | 'err' | 'mute'
}

const SPECS: Record<HarnessState, Spec> = {
  idle: { label: 'Ready', icon: <Sparkles size={13} />, tone: 'mute' },
  thinking: { label: 'Thinking', icon: <Brain size={13} />, tone: 'accent' },
  working: { label: 'Working', icon: <Loader2 size={13} />, spin: true, tone: 'accent' },
  editing: { label: 'Editing', icon: <PenLine size={13} />, tone: 'accent' },
  streaming: { label: 'Streaming', icon: <Sparkles size={13} />, tone: 'accent' },
  retrying: { label: 'Retrying', icon: <RotateCw size={13} />, spin: true, tone: 'warn' },
  falling_back: { label: 'Falling back', icon: <TriangleAlert size={13} />, tone: 'warn' },
  running_tool: { label: 'Running tool', icon: <Wrench size={13} />, spin: false, tone: 'accent' },
  done: { label: 'Done', icon: <Check size={13} />, tone: 'ok' },
  error: { label: 'Error', icon: <TriangleAlert size={13} />, tone: 'err' },
  cancelled: { label: 'Stopped', icon: <CircleSlash size={13} />, tone: 'mute' }
}

const ANIMATED: HarnessState[] = ['thinking', 'working', 'editing', 'streaming', 'retrying', 'falling_back', 'running_tool']

export function StatusIndicator({
  state,
  detail,
  startedAt
}: {
  state: HarnessState
  detail?: string
  startedAt?: number
}): JSX.Element | null {
  const animated = ANIMATED.includes(state)
  const elapsed = useElapsed(startedAt, animated)
  if (state === 'idle') return null
  const spec = SPECS[state]
  return (
    <span className={`status status--${spec.tone ?? 'mute'}`} role="status" aria-live="polite">
      <span className={spec.spin ? 'status__icon status__icon--spin' : 'status__icon'}>{spec.icon}</span>
      <span className={animated ? 'status__label shimmer' : 'status__label'}>{spec.label}</span>
      {detail && <span className="status__detail">{detail}</span>}
      {animated && startedAt !== undefined && <span className="status__detail">{formatElapsed(elapsed)}</span>}
    </span>
  )
}
