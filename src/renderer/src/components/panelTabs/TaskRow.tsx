import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDown, ArrowUpRight, Check, ChevronRight, CircleSlash, CornerDownLeft, FolderOpen, Terminal, TimerOff, TriangleAlert
} from 'lucide-react'
import type { BackgroundTask } from '../../../../shared/ipc'
import { api } from '../../lib/api'
import { plural } from '../../lib/format'
import {
  formatRuntime, lastLine, readyTarget, runtimeMs, shellName, statusLine, tailLines, tailPath, taskState, type ReadyTarget
} from '../../lib/taskModel'
import { useStickToBottom } from '../../lib/useStickToBottom'
import { useTaskTail, type TailView } from '../../lib/useTaskTail'
import { useTasks } from '../../state/tasks'
import { ActivityGlyph } from '../../theme/StateIcons'
import { CommandOutputPanel } from '../CommandOutputPanel'

const TAIL_LINES = 300
const SEND_MAX_CHARS = 4096
const GLYPH = 15

function StateGlyph({ task }: { task: BackgroundTask }): JSX.Element {
  switch (taskState(task)) {
    case 'running': return <ActivityGlyph kind="running" active size={GLYPH} />
    case 'done': return <Check className="task__glyph task__glyph--done" size={GLYPH} strokeWidth={1.75} aria-hidden="true" />
    case 'failed': return <TriangleAlert className="task__glyph task__glyph--failed" size={GLYPH} strokeWidth={1.75} aria-hidden="true" />
    case 'timed_out': return <TimerOff className="task__glyph task__glyph--timed-out" size={GLYPH} strokeWidth={1.75} aria-hidden="true" />
    case 'stopped': return <CircleSlash className="task__glyph task__glyph--stopped" size={GLYPH} strokeWidth={1.75} aria-hidden="true" />
  }
}

function ReadyLine({ target }: { target: ReadyTarget }): JSX.Element | null {
  if (target.kind === 'line') return null
  if (target.kind === 'port') return <p className="task__status">{target.label}</p>
  return (
    // Opens through the window's external-link allowlist (http and https only); the address was checked to be this computer's.
    <a className="task__ready" href={target.href} target="_blank" rel="noreferrer" title={target.href}>
      {target.label}
      <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
    </a>
  )
}

/** Ends the process tree behind an armed confirmation, never a browser dialog. */
function StopControl({ task, armed, onArm }: { task: BackgroundTask; armed: boolean; onArm: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm task__stop ${armed ? 'is-armed' : ''}`}
      onClick={onArm}
      aria-label={`Stop ${task.command}`}
      aria-expanded={armed}
      title="Ends the process and its children"
    >
      Stop
    </button>
  )
}

function StopConfirm({ task, onDone }: { task: BackgroundTask; onDone: (note?: { tone: 'error' | 'warn'; text: string }) => void }): JSX.Element {
  const keep = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  // The safe choice has focus, so a stray Enter never ends a server.
  useEffect(() => keep.current?.focus(), [])

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.stopTask(task.id)
      if (!result.ok) onDone({ tone: 'error', text: result.error ?? 'The task could not be stopped.' })
      else if (result.error) onDone({ tone: 'warn', text: `The task was stopped, but its process tree may not have ended cleanly. ${result.error}` })
      else onDone()
    } catch (error) {
      onDone({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div className="confirm task__confirm" role="group" aria-label={`Stop ${task.command}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onDone() } }}>
      <p>Ends the process and every process it started. Its output so far is kept.</p>
      <div className="confirm__actions">
        <button type="button" className="btn btn--danger btn--sm" disabled={busy} onClick={() => void stop()}>{busy ? 'Stopping' : 'Stop task'}</button>
        <button type="button" className="btn btn--ghost btn--sm" ref={keep} disabled={busy} onClick={() => onDone()}>Keep running</button>
      </div>
    </div>
  )
}

function SendInput({ task }: { task: BackgroundTask }): JSX.Element {
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const busy = useRef(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy.current) return
    // An empty field sends the Enter key, which is what "Press Enter to continue" waits for.
    const line = text === '' ? '\n' : text
    busy.current = true
    setError(undefined)
    try {
      const result = await api.sendTaskInput(task.id, line)
      if (result.ok) {
        setSent((previous) => [...previous, line].slice(-3))
        setText('')
      } else setError(result.error ?? 'The input was not delivered.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="task__send">
      <form onSubmit={(event) => void submit(event)}>
        <input
          className="input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Send a line to the process"
          aria-label={`Send input to ${task.command}`}
          maxLength={SEND_MAX_CHARS}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="btn btn--sm" title={text === '' ? 'Send the Enter key' : 'Send this line'}>
          <CornerDownLeft size={13} strokeWidth={1.75} aria-hidden="true" />Send
        </button>
      </form>
      {sent.length > 0 && (
        <ul className="task__sent" aria-label="Sent to this process">
          {sent.map((line, index) => (
            <li key={`${index}:${line}`}>
              <Check size={12} strokeWidth={2} aria-hidden="true" />
              {line === '\n' ? <span className="task__enter">Enter key</span> : <code>{line.replace(/\n$/, '')}</code>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="callout callout--error task__note" role="alert"><TriangleAlert size={13} aria-hidden="true" /><span className="callout__body">{error}</span></p>}
    </div>
  )
}

function OutputTail({ task, view }: { task: BackgroundTask; view: TailView }): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLPreElement>(null)
  const { atBottom, scrollToBottom } = useStickToBottom(scroller, content, task.id)
  const lines = useMemo(() => tailLines(view.raw, TAIL_LINES), [view.raw])
  const running = task.status === 'running'
  const [full, setFull] = useState(false)
  const [revealError, setRevealError] = useState<string>()

  const reveal = async (): Promise<void> => {
    try {
      await api.revealCommandOutput(task.conversationId, task.outputId)
      setRevealError(undefined)
    } catch (reason) {
      setRevealError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const counted = view.complete && lines.length < TAIL_LINES ? plural(lines.length, 'line') : `Showing the last ${plural(lines.length, 'line')}`
  return (
    <>
      <div className="task__tailwrap">
        <div className="task__tail" ref={scroller} tabIndex={0} role="log" aria-label={`Output of ${task.command}`}>
          {lines.length > 0
            ? <pre ref={content}>{lines.join('\n')}</pre>
            : <pre ref={content} className="task__quiet">{view.loading ? 'Loading output…' : running ? 'No output yet.' : 'No output.'}</pre>}
        </div>
        {!atBottom && lines.length > 0 && (
          <button type="button" className="scrolldown" onClick={scrollToBottom} aria-label="Scroll to latest output"><ArrowDown size={16} /></button>
        )}
      </div>
      {view.artifact?.truncated && (
        <p className="callout callout--warn task__note"><TriangleAlert size={13} aria-hidden="true" /><span className="callout__body">Saved output reached its size limit, so newer lines are not shown here.</span></p>
      )}
      {view.error && <p className="callout callout--error task__note" role="alert"><TriangleAlert size={13} aria-hidden="true" /><span className="callout__body">{view.error}</span></p>}
      {revealError && <p className="callout callout--error task__note" role="alert"><TriangleAlert size={13} aria-hidden="true" /><span className="callout__body">{revealError}</span></p>}
      <div className="task__tailbar">
        <span>{lines.length > 0 ? counted : ''}</span>
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFull(true)}><Terminal size={13} strokeWidth={1.75} aria-hidden="true" />Open full output</button>
        <button type="button" className="ib task__reveal" onClick={() => void reveal()} aria-label="Reveal saved output file" title="Reveal saved output file"><FolderOpen size={14} /></button>
      </div>
      {full && <CommandOutputPanel conversationId={task.conversationId} outputId={task.outputId} onClose={() => setFull(false)} />}
    </>
  )
}

function Facts({ task }: { task: BackgroundTask }): JSX.Element {
  const started = new Date(task.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return (
    <dl className="task__facts">
      <dt>Shell</dt><dd>{shellName(task.shell)}</dd>
      <dt>Started</dt><dd>{started}</dd>
      <dt>Folder</dt><dd title={task.cwd}>{tailPath(task.cwd)}</dd>
      {task.pid !== undefined && <><dt>Process</dt><dd>{task.pid}</dd></>}
    </dl>
  )
}

export function TaskRow({ task, now, defaultOpen }: { task: BackgroundTask; now: number; defaultOpen: boolean }): JSX.Element {
  const detailId = useId()
  const open = useTasks((state) => state.open[task.id] ?? defaultOpen)
  const setOpen = useTasks((state) => state.setOpen)
  const [armed, setArmed] = useState(false)
  const [note, setNote] = useState<{ tone: 'error' | 'warn'; text: string }>()
  const state = taskState(task)
  const running = state === 'running'
  const view = useTaskTail(task, open ? 1000 : 2500)
  const last = useMemo(() => lastLine(view.raw), [view.raw])
  const target = running ? readyTarget(task.readyHint) : undefined
  const started = new Date(task.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  return (
    <li className="task" data-state={state} data-open={open}>
      <div className="task__head">
        <button
          type="button"
          className="task__summary"
          onClick={() => setOpen(task.id, !open)}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
        >
          <ChevronRight className="task__chev" size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="task__icon"><StateGlyph task={task} /></span>
          <span className="task__cmd mono" title={task.command}>{task.command}</span>
          <span className="task__time" title={running ? `Started at ${started}` : undefined}>{formatRuntime(runtimeMs(task, now))}</span>
          {/* After the visible text, so the name still contains it. */}
          <span className="sr-only">{running ? ', running' : `, ${statusLine(task, now)}`}</span>
        </button>
        {running && <StopControl task={task} armed={armed} onArm={() => setArmed((value) => !value)} />}
      </div>
      <div className="task__meta">
        {target && <ReadyLine target={target} />}
        {!running && <p className="task__status">{statusLine(task, now)}</p>}
        {last && <p className="task__last mono" title={last}>{last}</p>}
      </div>
      {armed && running && <StopConfirm task={task} onDone={(result) => { setArmed(false); setNote(result) }} />}
      {note && <p className={`callout ${note.tone === 'error' ? 'callout--error' : 'callout--warn'} task__note task__note--row`} role={note.tone === 'error' ? 'alert' : 'status'}><TriangleAlert size={13} aria-hidden="true" /><span className="callout__body">{note.text}</span></p>}
      {open && (
        <div className="task__detail" id={detailId}>
          <Facts task={task} />
          <OutputTail task={task} view={view} />
          {running && <SendInput task={task} />}
        </div>
      )}
    </li>
  )
}
