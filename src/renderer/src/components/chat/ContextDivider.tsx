import { useId, useState } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { summaryHeadline, type SummaryStats } from '../../state/contextCost'
import { Markdown } from '../Markdown'
import '../context.css'

interface ContextDividerProps {
  /** What stands in for the earlier messages, when one was written. */
  summary?: string
  /** Messages above this line in the thread: what the summary replaced. */
  messagesAbove: number
  /** What the summary saved, while this session still knows it. */
  stats?: SummaryStats
  busy: boolean
  onRestore: () => Promise<void>
}

/**
 * Marks where the model's context starts. Everything above the line is still in the
 * thread and still saved; new requests begin from the summary (or from here when no
 * summary was written).
 */
export function ContextDivider({ summary, messagesAbove, stats, busy, onRestore }: ContextDividerProps): JSX.Element {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string>()

  const restore = (): void => {
    setRestoring(true)
    setError(undefined)
    onRestore()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not restore the full context.'))
      .finally(() => setRestoring(false))
  }
  const summarized = stats?.messagesSummarized ?? messagesAbove
  const headline = summary
    ? summarized > 0 ? summaryHeadline(summarized, stats) : 'Earlier messages summarized'
    : 'Earlier messages kept in history'

  return (
    <section className="ctxcut" aria-label="Where the model's context starts">
      <div className="ctxcut__row">
        <History size={14} aria-hidden="true" />
        <span className="ctxcut__label">{headline}</span>
        <span className="ctxcut__actions">
          {summary && (
            <button className="ctxcut__btn" aria-expanded={open} aria-controls={`${id}-summary`} onClick={() => setOpen((value) => !value)}>
              <ChevronRight size={13} aria-hidden="true" />
              {open ? 'Hide summary' : 'Show summary'}
            </button>
          )}
          <button className="ctxcut__btn" disabled={busy || restoring} onClick={restore}>
            {restoring ? 'Restoring…' : 'Restore full context'}
          </button>
        </span>
      </div>
      <p className="ctxcut__note">
        {summary
          ? 'New requests start from this summary and the messages below. Full history stays saved.'
          : 'Only the messages below are included in new requests. No summary was written.'}
      </p>
      {summary && open && (
        <div className="ctxcut__summary" id={`${id}-summary`}>
          <div className="prose"><Markdown text={summary} /></div>
        </div>
      )}
      {error && <p className="ctxcut__note ctxcut__error" role="alert">{error}</p>}
    </section>
  )
}
