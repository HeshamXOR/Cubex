import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, MessageSquare, Pencil, X } from 'lucide-react'
import { api } from '../lib/api'
import { plural, splitPath } from '../lib/format'
import { describeRange, describeRangeInline } from '../lib/hunkReview'
import { reviewRequest } from '../lib/reviewRequest'
import { useQueuedComments, useReviewComments, type QueuedComment } from '../state/reviewComments'
import type { ReviewComment } from '../../../shared/ipc'
import { CommentEditor } from './CommentEditor'
import './hunks.css'

/** What the main process is told: the comment, without what only the tray needs. */
const forSending = ({ id, path, startLine, endLine, side, hunkId, text }: QueuedComment): ReviewComment =>
  ({ id, path, startLine, endLine, side, ...(hunkId ? { hunkId } : {}), text })

interface Props {
  conversationId: string
  /** Cubex is mid-turn: a message to it waits until the turn is over. */
  working: boolean
  onOpenFile: (path: string) => void
}

/** The comments written on hunks, waiting above the footer to be sent to Cubex as one message. */
export function CommentTray({ conversationId, working, onOpenFile }: Props): JSX.Element {
  const queued = useQueuedComments(conversationId)
  const edit = useReviewComments((state) => state.edit)
  const remove = useReviewComments((state) => state.remove)
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const [sent, setSent] = useState<number>()

  useEffect(() => { setEditing(undefined); setError(undefined); setSent(undefined) }, [conversationId])
  // Comments written after a send are a new batch: the confirmation of the last one has done its job.
  useEffect(() => { if (queued.length) setSent(undefined) }, [queued.length])

  const send = async (): Promise<void> => {
    const batch = queued
    setSending(true)
    setError(undefined)
    try {
      await api.sendReviewComments(conversationId, batch.map(forSending), { request: reviewRequest() })
      remove(conversationId, batch.map((comment) => comment.id))
      setEditing(undefined)
      setSent(batch.length)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'The comments could not be sent.')
    } finally {
      setSending(false)
    }
  }

  const sentText = sent === undefined ? '' : `Sent ${plural(sent, 'comment')} to Cubex. It is working on ${sent === 1 ? 'it' : 'them'} now.`
  const live = <p className="sr-only" role="status">{sentText}</p>
  if (!queued.length) {
    return (
      <>
        {live}
        {sent !== undefined && (
          <div className="tray tray--sent" aria-hidden="true">
            <Check size={14} />
            <span>{sentText}</span>
            <button type="button" className="ib" tabIndex={-1} onClick={() => setSent(undefined)}><X size={14} /></button>
          </div>
        )}
      </>
    )
  }

  const why = sending ? 'Sending…' : working ? 'Cubex is working. You can send these once its turn has finished.' : undefined
  return (
    <>
      {live}
      <section className="tray" aria-label="Comments to send">
        <div className="tray__head">
          <MessageSquare size={14} aria-hidden="true" />
          <span>{plural(queued.length, 'comment')} ready to send</span>
          <span className="grow" />
          <button type="button" className="tray__toggle" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
            {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
        {open && (
          <ul className="tray__list">
            {queued.map((comment) => (
              <li className="tray__item" key={comment.id}>
                {editing?.id === comment.id ? (
                  <div className="tray__main tray__edit">
                    <CommentEditor
                      where={describeRangeInline(comment)}
                      text={editing.text}
                      onChange={(text) => setEditing({ id: comment.id, text })}
                      submitLabel="Save"
                      onSubmit={() => { edit(conversationId, comment.id, editing.text); setEditing(undefined) }}
                      onCancel={() => setEditing(undefined)}
                    />
                  </div>
                ) : (
                  <>
                    <div className="tray__main">
                      <button type="button" className="tray__where" onClick={() => onOpenFile(comment.path)} title={comment.excerpt ? `${comment.path}: ${comment.excerpt}` : comment.path}>
                        <span className="tray__file">{splitPath(comment.path).name}</span>{' '}{describeRange(comment)}
                      </button>
                      <p className="tray__text">{comment.text}</p>
                    </div>
                    <div className="tray__actions">
                      <button type="button" className="ib" aria-label={`Edit comment on ${splitPath(comment.path).name}, ${describeRangeInline(comment)}`} title="Edit comment" onClick={() => setEditing({ id: comment.id, text: comment.text })}>
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      <button type="button" className="ib" aria-label={`Remove comment on ${splitPath(comment.path).name}, ${describeRangeInline(comment)}`} title="Remove comment" onClick={() => remove(conversationId, [comment.id])}>
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="tray__bar">
          <p className={`tray__why${error ? ' tray__why--error' : ''}`} role={error ? 'alert' : undefined}>{error ?? why}</p>
          <button type="button" className="btn pri sm" disabled={sending || working} onClick={() => void send()}>
            Send {plural(queued.length, 'comment')} to Cubex
          </button>
        </div>
      </section>
    </>
  )
}
