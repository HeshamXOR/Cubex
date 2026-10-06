import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, FileOutput, Info, MessagesSquare, Paperclip, Plug, Settings2, Wrench, X } from 'lucide-react'
import { autoCompactAt, resolveCompactionPolicy } from '@shared/contextPolicy'
import type { ContextUsageSnapshot } from '../../../shared/ipc'
import { compactTokens } from '../lib/format'
import { openSettingsGroup } from '../lib/settingsLink'
import { useStore } from '../state/store'
import './context.css'

interface ContextMeterProps {
  usage?: ContextUsageSnapshot
  contextWindow?: number
  /** What the provider reported for the answer to that request, once it has finished. */
  lastReply?: { outputTokens?: number; reasoningTokens?: number }
  /** Replace older messages in new requests with a summary. Omit when there is no task to summarize. */
  onCompact?: () => void
  /** Why summarizing is unavailable right now, shown in place of the explanation. */
  compactBlockedReason?: string
}

const sectionIcons = {
  system: Settings2,
  conversation: MessagesSquare,
  toolResults: FileOutput,
  tools: Wrench,
  mcp: Plug,
  attachments: Paperclip
}

function tokenLabel(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? 'token' : 'tokens'}`
}

/** A request snapshot, rather than a transcript-size proxy or a billing total. */
export function ContextMeter({ usage, contextWindow: selectedWindow, lastReply, onCompact, compactBlockedReason }: ContextMeterProps): JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const summarize = useRef<HTMLButtonElement>(null)
  const confirmAction = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  // The same policy main reads for every request, so the tick sits where summarizing really starts.
  const policy = resolveCompactionPolicy(useStore((state) => state.settings?.ai))
  // A saved request belongs to its original model, even after the picker changes.
  const requestedWindow = usage ? usage.contextWindow : selectedWindow
  const contextWindow = requestedWindow !== undefined && Number.isFinite(requestedWindow) && requestedWindow > 0 ? requestedWindow : undefined
  // The anchored count rests on what the provider actually measured; the pure
  // estimate is the weaker number and only used until a report arrives.
  const finite = (value: number | undefined): number | undefined => (value !== undefined && Number.isFinite(value) ? value : undefined)
  const used = Math.max(0, finite(usage?.contextTokens) ?? finite(usage?.estimatedTokens) ?? 0)
  const reserve = Math.max(0, finite(usage?.outputReserve) ?? 0)
  const reserveKnown = usage?.outputReserveKnown !== false
  // Measure against what a request may actually fill, not the raw window, so
  // the 80% mark here is the same 80% that triggers automatic compaction.
  const inputBudget = finite(usage?.inputBudget)
  const budget = inputBudget !== undefined && inputBudget > 0 ? inputBudget : contextWindow
  const available = contextWindow ? Math.max(0, contextWindow - used - reserve) : undefined
  const percent = budget ? Math.round((used / budget) * 100) : undefined
  const progress = budget ? Math.min(100, Math.max(0, used / budget * 100)) : 0
  const meterState = !usage ? 'empty' : contextWindow ? 'known' : 'unknown'
  const pressure = budget && used >= budget ? 'full' : percent !== undefined && percent >= 80 ? 'high' : ''
  const percentLabel = percent !== undefined ? used > 0 && percent < 1 ? '<1%' : `${percent}%` : undefined
  const estimateOnly = usage?.contextBasis === 'estimated'
  // Where automatic summarizing starts, in tokens; nothing is marked when it is switched off.
  const triggerAt = policy.auto && budget ? autoCompactAt(budget, policy.threshold) : undefined
  const thresholdPercent = Math.round(policy.threshold * 100)

  const close = (returnFocus = false): void => {
    setOpen(false)
    setConfirming(false)
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
  }
  const cancelConfirm = (): void => {
    setConfirming(false)
    requestAnimationFrame(() => summarize.current?.focus({ preventScroll: true }))
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const bounds = trigger.current?.getBoundingClientRect()
      if (!bounds) return
      const margin = 12
      const width = Math.min(376, window.innerWidth - margin * 2)
      const above = bounds.top - margin - 8
      const below = window.innerHeight - bounds.bottom - margin - 8
      const opensAbove = above >= Math.min(320, below)
      setPosition({
        width,
        left: Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin)),
        ...(opensAbove ? { bottom: window.innerHeight - bounds.top + 8 } : { top: bounds.bottom + 8 }),
        maxHeight: Math.max(120, opensAbove ? above : below)
      })
    }
    place()
    // The first render is hidden until its anchor has been measured.
    const focusFrame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place)
    if (trigger.current) observer.observe(trigger.current)
    return () => {
      cancelAnimationFrame(focusFrame)
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Consume Escape before the chat's global generation-cancel shortcut.
      event.preventDefault()
      event.stopPropagation()
      // Escape backs out of the question first, and only then closes the panel.
      if (confirming) cancelConfirm()
      else close(true)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, confirming])

  useEffect(() => {
    if (confirming) confirmAction.current?.focus({ preventScroll: true })
  }, [confirming])

  const toggleSection = (sectionId: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const percentWords = percent === undefined ? '' : used > 0 && percent < 1 ? 'under 1 percent' : `${percent} percent`
  const pressureNote = pressure === 'full' ? 'The input and output budget is full. ' : pressure === 'high' ? 'Context usage is high. ' : ''
  // The name starts with what the button shows, so voice control and screen readers match the page.
  const state = usage
    ? contextWindow
      ? `${compactTokens(used)} of ${compactTokens(contextWindow)} used, ${percentWords} of the ${inputBudget !== undefined && inputBudget > 0 ? 'input budget' : 'context window'}`
      : `${compactTokens(used)} tokens, model context window unknown`
    : `No request yet${contextWindow ? `, model context window ${compactTokens(contextWindow)}` : ''}`
  const summary = `${state}. ${pressureNote}Show context details`

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`context-meter ${open ? 'is-open' : ''} ${pressure ? `is-${pressure}` : ''}`}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={summary}
        onClick={() => open ? close() : setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <svg className="context-meter__ring" data-state={meterState} width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle className="context-meter__track" cx="10" cy="10" r="7.5" pathLength="100" strokeWidth="3" strokeDasharray={meterState === 'unknown' ? '7 5' : undefined} />
          {meterState === 'known' && <circle className="context-meter__progress" cx="10" cy="10" r="7.5" pathLength="100" strokeWidth="3" strokeLinecap="round" strokeDasharray="100" strokeDashoffset={100 - progress} opacity={progress > 0 ? 1 : 0} />}
          {/* A short mark across the ring where automatic summarizing starts. */}
          {meterState === 'known' && triggerAt !== undefined && <line className="context-meter__tick" x1="15.6" y1="10" x2="19.8" y2="10" strokeWidth="1.6" transform={`rotate(${policy.threshold * 360} 10 10)`} />}
        </svg>
        {usage && <span className="context-meter__label">{compactTokens(used)}</span>}
      </button>

      {open && createPortal(
        <div
          id={id}
          ref={panel}
          className={`context-popover ${pressure ? `is-${pressure}` : ''}`}
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-note`}
          tabIndex={-1}
          style={position}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null
            if (next && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) close()
          }}
        >
          {/* Plain blocks, not <header> and <footer>: portalled to the body, those would become extra page landmarks. */}
          <div className="context-popover__header">
            <div><h2 id={`${id}-title`}>Context</h2><p>{usage ? 'Latest request' : 'Request budget'}</p></div>
            <button type="button" className="context-popover__close" onClick={() => close(true)} aria-label="Close context details"><X size={16} /></button>
          </div>

          <div className="context-popover__body">
            {usage ? <>
              <div className="context-popover__total">
                <span className="context-popover__number"><span>≈</span>{used.toLocaleString()}<small>tokens</small></span>
                <span className="context-popover__percent">{percentLabel !== undefined ? `${percentLabel} of ${compactTokens(contextWindow!)}` : 'Window unknown'}</span>
              </div>
              <p className="context-popover__basis">
                {estimateOnly
                  ? 'Estimated. The provider has not reported a token count for this task yet.'
                  : `Measured: ${compactTokens(usage.anchorTokens ?? used)} reported by the provider, plus ${compactTokens(usage.appendedTokens ?? 0)} added since, the latest reply and anything after it.`}
              </p>

              {contextWindow && <>
                <div className="context-popover__budget" aria-label={`Estimated input ${tokenLabel(used)}, output reserve ${reserveKnown ? tokenLabel(reserve) : 'set by the provider'}, ${tokenLabel(available!)} ${reserveKnown ? 'available' : 'before output'}${triggerAt !== undefined ? `. Automatic summarizing starts at ${tokenLabel(triggerAt)}` : ''}`} role="img">
                  <span className="context-popover__budget-used" style={{ width: `${Math.min(100, used / contextWindow * 100)}%` }} />
                  <span className="context-popover__budget-reserve" style={{ width: `${Math.min(Math.max(0, 100 - used / contextWindow * 100), reserve / contextWindow * 100)}%` }} />
                  {triggerAt !== undefined && <span className="context-popover__tick" style={{ left: `${Math.min(100, triggerAt / contextWindow * 100)}%` }} />}
                </div>
                <div className="context-popover__budget-legend">
                  <span><i className="context-popover__reserve-key" />{reserveKnown ? `${compactTokens(reserve)} output reserve` : 'Output: provider default'}</span>
                  <span>{compactTokens(available!)} {reserveKnown ? 'available' : 'before output'}</span>
                </div>
                {triggerAt !== undefined && <div className="context-popover__budget-legend context-popover__budget-legend--tick"><span><i className="context-popover__tick-key" />Summarizes at {compactTokens(triggerAt)}</span><span>{thresholdPercent}% of the input budget</span></div>}
              </>}

              <div className="context-popover__section-heading"><span>Input breakdown</span><span>Est. tokens</span></div>
              <div className="context-popover__sections">
                {usage.sections.map((section) => {
                  const Icon = sectionIcons[section.id]
                  const hasDetails = !!section.details?.length
                  const isExpanded = expanded.has(section.id)
                  const uncountedMedia = section.id === 'attachments' && usage.attachmentEstimateIncomplete
                  const row = <>
                    <Icon size={15} strokeWidth={1.6} aria-hidden="true" />
                    <span className="context-popover__section-label">{section.label}{section.count !== undefined && <span className="context-popover__count">{section.count}</span>}</span>
                    <span className="context-popover__section-value" title={uncountedMedia ? 'Media token costs are unavailable' : undefined}>{uncountedMedia ? section.estimatedTokens ? `${section.estimatedTokens.toLocaleString()}+` : '—' : section.estimatedTokens.toLocaleString()}</span>
                    <ChevronDown className={`context-popover__chevron ${hasDetails ? '' : 'is-hidden'}`} size={12} aria-hidden="true" />
                  </>
                  return <div className={`context-popover__section ${isExpanded ? 'is-expanded' : ''}`} key={section.id} data-section={section.id}>
                    {hasDetails ? <button type="button" className="context-popover__section-row" aria-expanded={isExpanded} aria-controls={`${id}-${section.id}`} onClick={() => toggleSection(section.id)}>{row}</button> : <div className="context-popover__section-row">{row}</div>}
                    <div className="context-popover__section-track" aria-hidden="true"><span style={{ width: `${used ? Math.min(100, section.estimatedTokens / used * 100) : 0}%` }} /></div>
                    {hasDetails && isExpanded && <dl className="context-popover__details" id={`${id}-${section.id}`}>
                      {section.details!.map((detail) => <div key={detail.id}><dt title={detail.label}>{detail.label}{detail.count !== undefined && <span className="context-popover__count">{detail.count}</span>}</dt><dd>{uncountedMedia && !detail.estimatedTokens ? '—' : detail.estimatedTokens.toLocaleString()}</dd></div>)}
                    </dl>}
                  </div>
                })}
              </div>

              {!contextWindow && <div className="context-popover__unbounded-reserve"><span>Output reserve</span><span>{reserveKnown ? tokenLabel(reserve) : 'Provider default'}</span></div>}
              {usage.measuredInputTokens !== undefined && <div className="context-popover__measured"><span>Provider reported input<small>Measured for this request</small></span><strong>{tokenLabel(usage.measuredInputTokens)}</strong></div>}
              {/* The same request's answer. Thinking is part of it, and it is not part of the next request's context. */}
              {usage.measuredInputTokens !== undefined && lastReply?.outputTokens !== undefined && <div className="context-popover__measured context-popover__measured--follow"><span>Provider reported output<small>{lastReply.reasoningTokens ? `Includes ${tokenLabel(lastReply.reasoningTokens)} of thinking` : 'Includes any thinking'}</small></span><strong>{tokenLabel(lastReply.outputTokens)}</strong></div>}
              {usage.attachmentEstimateIncomplete && <p className="context-popover__warning"><Info size={14} />Media token costs are not included in this estimate.</p>}
              {pressure === 'high' && <p className="context-popover__warning">Context usage is high. A shorter conversation leaves more room for the next request.</p>}
              {pressure === 'full' && <p className="context-popover__warning">This estimate fills the input and output budget. Shorten the conversation or choose a larger context window.</p>}
              {onCompact && (
                <div className="context-popover__compact">
                  {confirming ? (
                    <div className="confirm" role="group" aria-labelledby={`${id}-confirm`}>
                      <p id={`${id}-confirm`}>Older messages are replaced by a short summary in new requests. The full transcript stays saved, and the thread lets you restore it. This sends one request to the model.</p>
                      <div className="confirm__actions">
                        <button ref={confirmAction} type="button" className="btn btn--primary btn--sm" onClick={() => { close(); onCompact() }}>Summarize</button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={cancelConfirm}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button ref={summarize} type="button" className={`btn context-popover__summarize ${pressure ? 'btn--primary' : ''}`} disabled={!!compactBlockedReason} onClick={() => setConfirming(true)}>Summarize earlier messages</button>
                  )}
                  <p>{compactBlockedReason ?? 'Replaces older messages in new requests with a short summary. Full history stays saved.'}</p>
                  <p>
                    {policy.auto
                      ? `Summarizes automatically at ${thresholdPercent}% of the input budget${triggerAt !== undefined ? `, about ${compactTokens(triggerAt)} tokens` : ''}.`
                      : 'Automatic summarizing is off.'}{' '}
                    <button type="button" className="context-popover__link" onClick={() => { close(); openSettingsGroup('compaction') }}>Summarizing settings</button>
                  </p>
                </div>
              )}
            </> : <div className="context-popover__empty"><p>Send a message to see how system instructions, conversation, tools, and MCP use this model’s context.</p>{contextWindow && <div><span>Model context window</span><strong>{tokenLabel(contextWindow)}</strong></div>}</div>}
          </div>

          <div className="context-popover__footer">
            {usage?.model && <span className="context-popover__model" title={usage.model}>{usage.model}</span>}
            <p id={`${id}-note`}>{usage ? 'Estimates use the assembled request. Draft text is not included; tokenization varies by model.' : 'Detailed usage appears when Cubex assembles a request.'}</p>
          </div>
        </div>, document.body
      )}
    </>
  )
}
