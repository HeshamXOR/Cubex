import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import { formatSeconds } from '../../lib/format'
import { StateIcon } from '../../status/StatusIndicator'
import './policy.css'

/** Plain text with `code` spans where the text has backticks. Messages from the main process use them for commands and paths. */
export function Prose({ text }: { text: string }): JSX.Element {
  return <>{text.split('`').map((piece, index) => (index % 2 === 1 ? <code key={index} className="pol-code">{piece}</code> : piece))}</>
}

/** Work in progress is the turning star, never a spinner. */
export function Working({ children }: { children: ReactNode }): JSX.Element {
  return <div className="pol-state" role="status"><StateIcon state="working" size={14} />{children}</div>
}

/** What a list says when there is nothing in it yet: what will show up and how to make that happen. */
export function Empty({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pol-empty">
      <div className="pol-empty__title">{title}</div>
      <p className="pol-empty__body">{children}</p>
    </div>
  )
}

export function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="callout callout--error pol-callout" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <div className="callout__body"><strong>{title}</strong>{message}</div>
      {onRetry && (
        <div className="callout__actions">
          <button type="button" className="callout__action" onClick={onRetry}>Try again</button>
        </div>
      )}
    </div>
  )
}

/**
 * Remove, in two steps and in place: the first click turns the button into the question and offers
 * Cancel; it drops back by itself after a few seconds, or when focus leaves. One button stays mounted
 * so keyboard focus is not lost between the steps.
 */
export function ArmedRemove({ subject, noun, onConfirm, disabled }: {
  /** What is being removed, for screen readers: "the npm test rule". */
  subject: string
  /** The word in the question: "Remove rule?" */
  noun: string
  onConfirm: () => void
  disabled?: boolean
}): JSX.Element {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number>()
  const statusId = useId()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const disarm = (): void => {
    window.clearTimeout(timer.current)
    setArmed(false)
  }
  const click = (): void => {
    if (armed) {
      disarm()
      onConfirm()
      return
    }
    setArmed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setArmed(false), 5000)
  }
  return (
    <span
      className="pol-remove"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) disarm() }}
      onKeyDown={(event) => { if (event.key === 'Escape' && armed) { event.stopPropagation(); disarm() } }}
    >
      {armed && <button type="button" className="btn btn--sm btn--ghost" onClick={disarm}>Cancel</button>}
      <button
        type="button"
        className={`btn btn--sm ${armed ? 'btn--danger' : 'btn--ghost'}`}
        onClick={click}
        disabled={disabled}
        // Armed, the visible words are the name, so a voice control user can say them; the sentence below says what is being removed.
        aria-label={armed ? undefined : `Remove ${subject}`}
        aria-describedby={armed ? statusId : undefined}
      >
        {armed ? `Remove ${noun}?` : 'Remove'}
      </button>
      <span className="sr-only" role="status" id={statusId}>{armed ? `Remove ${subject}? Choose Remove ${noun} to confirm, or Cancel.` : ''}</span>
    </span>
  )
}

/** A quiet text button with a turning chevron, for lists that open and close. */
export function Disclosure({ label, open, onToggle, controls }: { label: string; open: boolean; onToggle: () => void; controls?: string }): JSX.Element {
  return (
    <button type="button" className="pol-toggle" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <ChevronRight size={14} aria-hidden="true" />{label}
    </button>
  )
}

/** How long something took: "340 ms" below a second, then the transcript's "1.2s". */
export function took(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : formatSeconds(ms)
}
