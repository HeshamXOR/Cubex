import { useMemo, useRef } from 'react'
import { Check, FileDiff, FileMinus, FilePlus, GitCompare, PanelRightClose, ShieldQuestion, Terminal, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../state/store'
import { useConversationTasks } from '../state/tasks'
import { activitySpecFor } from '../status/StatusIndicator'
import { AnimatedMark } from '../theme/AnimatedMark'
import { basename, formatSeconds, plural } from '../lib/format'
import { setRailCollapsed } from '../lib/runRail'
import { deriveRunSteps, type RunStepState } from '../lib/runSteps'
import { formatRuntime, isRunning, runtimeMs, sortTasks } from '../lib/taskModel'
import { useChanges } from '../lib/useSessionChanges'
import { useNow } from '../lib/useNow'
import { Stat } from './ChangeStat'
import './graphite.css'

const FILE_LIMIT = 8

function StepGlyph({ state }: { state: RunStepState }): JSX.Element {
  if (state === 'running') return <AnimatedMark size={14} state="working" className="rail-glyph" />
  if (state === 'waiting') return <ShieldQuestion size={14} strokeWidth={1.75} className="rail-glyph rail-glyph--need" aria-hidden="true" />
  if (state === 'error') return <X size={14} strokeWidth={1.75} className="rail-glyph" aria-hidden="true" />
  return <Check size={14} strokeWidth={2} className="rail-glyph rail-glyph--done" aria-hidden="true" />
}

const STATE_WORD: Record<RunStepState, string> = { done: 'Done', running: 'Working', waiting: 'Waiting for you', error: 'Failed' }


/** When each step was first seen running and when it finished, for the steps this window watched happen. */
function useStepTimes(steps: ReadonlyArray<{ key: string; state: RunStepState }>): Map<string, { start: number; end?: number }> {
  const times = useRef(new Map<string, { start: number; end?: number }>())
  const now = Date.now()
  for (const step of steps) {
    const seen = times.current.get(step.key)
    if (!seen && (step.state === 'running' || step.state === 'waiting')) times.current.set(step.key, { start: now })
    else if (seen && !seen.end && (step.state === 'done' || step.state === 'error')) seen.end = now
  }
  return times.current
}

/** The run rail: this turn's steps, the files it changed and what keeps running in the background. */
export function RunRail(): JSX.Element {
  const messages = useStore((s) => s.liveMessages)
  const status = useStore((s) => s.status)
  const genStartedAt = useStore((s) => s.genStartedAt)
  const conversationId = useStore((s) => s.activeConversation?.id)
  const waiting = useStore(useShallow((s) => ({
    tool: s.pendingPermission?.toolName,
    plan: !!s.pendingPlan,
    question: !!s.pendingQuestion
  })))
  const openReview = useStore((s) => s.openReview)
  const { changes, reviewed } = useChanges()
  const tasks = useConversationTasks(conversationId)

  const working = !!activitySpecFor(status).active
  const steps = useMemo(() => deriveRunSteps(messages, waiting), [messages, waiting])
  const times = useStepTimes(steps)
  const running = useMemo(() => sortTasks(tasks).filter(isRunning), [tasks])
  const now = useNow(working || running.length > 0)

  const turnClock = useRef<{ id?: string; start?: number; end?: number }>({})
  if (turnClock.current.id !== conversationId) turnClock.current = { id: conversationId }
  if (working && genStartedAt !== undefined) turnClock.current.start = genStartedAt
  if (working) turnClock.current.end = undefined
  else if (turnClock.current.start !== undefined && turnClock.current.end === undefined) turnClock.current.end = Date.now()
  const turnMs = turnClock.current.start === undefined ? undefined : (turnClock.current.end ?? now) - turnClock.current.start

  const files = changes.files
  const shown = files.slice(0, FILE_LIMIT)

  return (
    <div className="rail" aria-label="Run">
      <div className="rail__head">
        <h4>This turn{turnMs !== undefined && turnMs > 0 && <span>{formatSeconds(turnMs)}</span>}</h4>
        <button className="rail__hide" onClick={() => setRailCollapsed(true)} aria-label="Hide run rail" title="Hide run rail"><PanelRightClose size={15} /></button>
      </div>
      {steps.length === 0 ? (
        <p className="rail__empty">{working ? `${activitySpecFor(status).label ?? 'Working'}.` : 'Steps appear here as the agent works.'}</p>
      ) : (
        <ol className="rail__steps">
          {steps.map((step) => {
            const t = times.get(step.key)
            const time = step.state === 'waiting' ? 'Waiting'
              : t ? (t.end ? (t.end - t.start >= 1000 ? formatSeconds(t.end - t.start) : '') : step.state === 'running' ? formatSeconds(now - t.start) : '')
              : ''
            return (
              <li key={step.key} className={step.state === 'waiting' ? 'is-now' : ''}>
                <StepGlyph state={step.state} />
                <span className="rail__label" title={step.label}>{step.label}<span className="sr-only">. {STATE_WORD[step.state]}</span></span>
                {time && <time className={step.state === 'waiting' ? 'is-need' : ''}>{time}</time>}
              </li>
            )
          })}
        </ol>
      )}

      <div className="rail__head rail__head--sec">
        <h4>Changed files{files.length > 0 && <span>{reviewed.count} of {files.length} reviewed</span>}</h4>
      </div>
      {files.length === 0 ? (
        <p className="rail__empty">No files changed yet.</p>
      ) : (
        <>
          <div className="rail__files">
            {shown.map((file) => {
              const Icon = file.status === 'added' ? FilePlus : file.status === 'deleted' ? FileMinus : FileDiff
              return (
                <button key={file.path} className="rail__file" onClick={() => openReview(file.path)} title={file.path}>
                  <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                  <code>{basename(file.path)}</code>
                  <Stat added={file.added} removed={file.removed} />
                </button>
              )
            })}
            {files.length > shown.length && <p className="rail__more">and {plural(files.length - shown.length, 'more file')}</p>}
          </div>
          <button className="rail__review" onClick={() => openReview()}><GitCompare size={14} strokeWidth={1.75} aria-hidden="true" />Review changes</button>
        </>
      )}

      <div className="rail__head rail__head--sec">
        <h4>Background<span>{running.length > 0 ? `${running.length} running` : 'none running'}</span></h4>
      </div>
      {running.length === 0 ? (
        <p className="rail__empty">Commands left running show up here.</p>
      ) : (
        <div className="rail__bg">
          {running.map((task) => (
            <button key={task.id} className="rail__task" onClick={() => useStore.setState({ panelOpen: true, panelTab: 'tasks' })} title={task.command}>
              <Terminal size={14} strokeWidth={1.75} aria-hidden="true" />
              <code>{task.command}</code>
              <small>{formatRuntime(runtimeMs(task, now))}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
