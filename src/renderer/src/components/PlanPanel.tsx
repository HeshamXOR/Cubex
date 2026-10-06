import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Check, Copy, FileText, FolderOpen, Send } from 'lucide-react'
import type { PlanAsk, PlanDecision } from '../../../shared/ipc'
import { PLAN_MAX_FEEDBACK_LENGTH } from '../../../shared/ipc'
import { Markdown } from './Markdown'
import { planFileName, planStatusLabel, planTitle, type PlanDocument } from './planPresentation'
import './plan.css'

export interface PlanPanelProps {
  plan: PlanAsk
  pending: boolean
  onResolve: (decision: PlanDecision, feedback?: string) => Promise<void>
  onClose: () => void
  plans?: PlanAsk[]
  onSelect?: (plan: PlanAsk) => void
  onReveal?: () => Promise<void>
}

const permissionNotes: Record<Exclude<PlanDecision, 'reject'>, string> = {
  default: 'Ask before making file changes.',
  acceptEdits: 'Allow file edits; keep other permission checks.',
  bypass: 'Allow every tool to run without permission prompts.'
}

/** Independent document review surface. Closing it never resolves a plan. */
export function PlanPanel({ plan, pending, onResolve, onClose, plans = [], onSelect, onReveal }: PlanPanelProps): JSX.Element {
  const doc: PlanDocument = plan
  const id = useId()
  const panelRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const [tab, setTab] = useState<'preview' | 'source'>('preview')
  const [mode, setMode] = useState<Exclude<PlanDecision, 'reject'>>('default')
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      mounted.current = false
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    setTab('preview')
    setRevising(false)
    setFeedback('')
    setError(undefined)
    setCopied(false)
    setMode('default')
    scrollRef.current?.scrollTo(0, 0)
  }, [plan.id])

  useEffect(() => {
    if (revising) feedbackRef.current?.focus()
  }, [revising])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  const resolve = async (decision: PlanDecision, note?: string): Promise<void> => {
    if (busy || !pending) return
    setError(undefined)
    setBusy(true)
    try {
      await onResolve(decision, note)
      if (mounted.current) setRevising(false)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not send your decision. Please try again.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(plan.plan)
      if (mounted.current) { setCopied(true); setError(undefined) }
    } catch {
      if (mounted.current) setError('Could not copy the plan. You can select the text in the Source tab.')
    }
  }

  const reveal = async (): Promise<void> => {
    try {
      await onReveal?.()
      if (mounted.current) setError(undefined)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open the plan location.')
    }
  }

  const handleKeys = (event: KeyboardEvent<HTMLElement>): void => {
    // Escape may cancel a running turn elsewhere. It must not decide this review.
    if (event.key === 'Escape') event.stopPropagation()
  }

  const versions = [...plans.filter((item) => item.id !== plan.id), plan].sort((a, b) => ((a as PlanDocument).createdAt ?? 0) - ((b as PlanDocument).createdAt ?? 0))
  const version = versions.findIndex((item) => item.id === plan.id) + 1
  const wordCount = plan.plan.trim() ? plan.plan.trim().split(/\s+/).length : 0
  const created = doc.createdAt && Number.isFinite(new Date(doc.createdAt).getTime()) ? new Date(doc.createdAt) : undefined

  return (
    <section className="plan-review" ref={panelRef} role="region" aria-labelledby={`${id}-title`} onKeyDown={handleKeys}>
        <header className="plan-review__header">
          <FileText size={16} strokeWidth={1.6} aria-hidden="true" />
          <div className="plan-review__identity">
            <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1} title={doc.path}>{planFileName(doc)}</h2>
          </div>
        </header>

        <div className="plan-review__toolbar">
          <div className="plan-review__tabs" role="tablist" aria-label="Plan format">
            {(['preview', 'source'] as const).map((value) => (
              <button key={value} id={`${id}-${value}-tab`} className={`plan-review__tab ${tab === value ? 'is-active' : ''}`} role="tab" aria-selected={tab === value} aria-controls={`${id}-content`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'source' : tab === 'preview' ? 'source' : 'preview'
                  setTab(next)
                  document.getElementById(`${id}-${next}-tab`)?.focus()
                }
              }}>{value === 'preview' ? 'Preview' : 'Source'}</button>
            ))}
          </div>
          <div className="plan-review__file-actions">
            {versions.length > 1 && onSelect && (
              <select aria-label="Plan version" className="plan-review__versions" value={plan.id} disabled={busy} onChange={(event) => {
                const selected = versions.find((item) => item.id === event.target.value)
                if (selected) onSelect(selected)
              }}>
                {versions.map((item, index) => <option value={item.id} key={item.id}>Version {index + 1}{index === versions.length - 1 ? ' (Latest)' : ''}</option>)}
              </select>
            )}
            <button className="plan-review__icon-btn" onClick={() => void copy()} aria-label={copied ? 'Markdown copied' : 'Copy Markdown'} title={copied ? 'Copied' : 'Copy Markdown'}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
            {doc.path && onReveal && <button className="plan-review__icon-btn" onClick={() => void reveal()} aria-label="Reveal plan file" title="Reveal Markdown file"><FolderOpen size={16} /></button>}
          </div>
        </div>

        <div className="plan-review__scroll" ref={scrollRef}>
          <div className="plan-review__document-meta">
            <span className={`plan-review__status ${pending ? 'is-pending' : ''}`}><span aria-hidden="true" />{planStatusLabel(doc, pending)}</span>
            <span>{versions.length > 1 && version > 0 ? `v${version}, ` : ''}{wordCount.toLocaleString()} words</span>
            {created && <time dateTime={created.toISOString()} title={created.toLocaleString()}>{created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>}
          </div>
          <div id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} tabIndex={0} className="plan-review__content">
            {tab === 'source' ? <pre className="plan-review__source">{plan.plan}</pre> : (
              <article className="plan-review__markdown">
                {!/^#\s+/m.test(plan.plan) && <h1>{planTitle(doc)}</h1>}
                {plan.plan.trim() ? <Markdown text={plan.plan} /> : <p className="plan-review__empty">This plan is empty. Request a revision before approving.</p>}
              </article>
            )}
          </div>
          {!pending && doc.feedback && <div className="plan-review__previous-feedback"><strong>Your feedback</strong><p>{doc.feedback}</p></div>}
        </div>

        <footer className="plan-review__footer">
          {error && <p className="plan-review__error" role="alert">{error}</p>}
          {pending ? revising ? (
            <form className="plan-review__feedback" onSubmit={(event) => { event.preventDefault(); if (feedback.trim()) void resolve('reject', feedback) }}>
              <div className="plan-review__feedback-heading">
                <button type="button" className="plan-review__icon-btn" onClick={() => setRevising(false)} disabled={busy} aria-label="Back to approval"><ArrowLeft size={16} /></button>
                <label htmlFor={`${id}-feedback`}>What should change?</label>
              </div>
              <textarea id={`${id}-feedback`} ref={feedbackRef} value={feedback} maxLength={PLAN_MAX_FEEDBACK_LENGTH} onChange={(event) => setFeedback(event.target.value)} placeholder="Describe the direction, constraints, or details the model should revise…" rows={3} disabled={busy} />
              <div className="plan-review__feedback-actions">
                <button type="button" className="plan-review__button plan-review__button--quiet" disabled={busy} onClick={() => void resolve('reject')}>Reject without feedback</button>
                <button type="submit" className="plan-review__button plan-review__button--primary" disabled={busy || !feedback.trim()}><Send size={14} />{busy ? 'Sending…' : 'Send feedback'}</button>
              </div>
              <p className="plan-review__note">Feedback returns the model to planning. Implementation stays paused.</p>
            </form>
          ) : (
            <>
              <div className="plan-review__approval-heading"><span>Ready for your review</span><span>Choose how to proceed</span></div>
              <div className="plan-review__approval-actions">
                <button className="plan-review__button plan-review__button--quiet" disabled={busy} onClick={() => setRevising(true)}>Reject plan</button>
                <select className="plan-review__permission" value={mode} disabled={busy} aria-label="Permissions after approval" aria-describedby={`${id}-permissions-note`} onChange={(event) => setMode(event.target.value as Exclude<PlanDecision, 'reject'>)}>
                  <option value="default">Ask before edits</option>
                  <option value="acceptEdits">Accept file edits</option>
                  <option value="bypass">Bypass permissions</option>
                </select>
                <button className="plan-review__button plan-review__button--primary" onClick={() => void resolve(mode)} disabled={busy || !plan.plan.trim()}><Check size={15} />{busy ? 'Approving…' : 'Approve plan'}</button>
              </div>
              <p id={`${id}-permissions-note`} className={`plan-review__note ${mode === 'bypass' ? 'is-warning' : ''}`}>{permissionNotes[mode]}</p>
            </>
          ) : <p className="plan-review__archived">{doc.status === 'approved' ? 'Approved for implementation.' : doc.status === 'rejected' ? 'The plan was returned to the model.' : doc.status === 'cancelled' ? 'This review was cancelled.' : 'This saved plan is available for reference.'} You can still read or copy this version.</p>}
          <span className="plan-review__sr-only" role="status">{copied ? 'Markdown copied to clipboard.' : ''}</span>
        </footer>
    </section>
  )
}
