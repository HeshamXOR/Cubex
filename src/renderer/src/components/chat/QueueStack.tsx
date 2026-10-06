import { CirclePause, CornerDownLeft, ListEnd, Paperclip, Pencil, ShieldQuestion, TriangleAlert, X } from 'lucide-react'
import { CubexMark } from '../../theme/Logo'
import { focusComposer } from '../../lib/composerFocus'
import { plural } from '../../lib/format'
import { QUEUE_LIMIT, describeGate, type QueueGate, type QueuedMessage } from '../../lib/messageQueue'
import { pullIntoComposer, useQueue, useQueueGate } from '../../state/queue'
import './queue.css'

const NOTHING: readonly QueuedMessage[] = []

/** Working shows the turning star, a queue that needs the person shows the amber marks the rest of the app uses. */
function GateIcon({ gate }: { gate: QueueGate }): JSX.Element {
  if (gate.action === 'hold') {
    if (gate.reason === 'needs_answer') return <ShieldQuestion size={14} className="queue__state queue__state--attention" aria-hidden="true" />
    return gate.reason === 'stopped'
      ? <CirclePause size={14} className="queue__state" aria-hidden="true" />
      : <TriangleAlert size={14} className="queue__state queue__state--attention" aria-hidden="true" />
  }
  return gate.action === 'wait' && gate.reason !== 'elsewhere'
    ? <CubexMark size={13} className="queue__state turning" />
    : <ListEnd size={14} className="queue__state" aria-hidden="true" />
}

/** Messages typed while a turn runs, stacked above the composer in the order they will be sent. */
export function QueueStack({ conversationId }: { conversationId: string | undefined }): JSX.Element | null {
  const queue = useQueue((state) => (conversationId ? state.queues[conversationId] : undefined)) ?? NOTHING
  const gate = useQueueGate(conversationId)
  const remove = useQueue((state) => state.remove)
  const sendNow = useQueue((state) => state.sendNow)
  if (!conversationId || queue.length === 0) return null

  const summarizing = gate.action === 'wait' && gate.reason === 'compacting'
  const interrupts = (gate.action === 'wait' && gate.reason === 'turn') || (gate.action === 'hold' && gate.reason === 'needs_answer')
  const sendTitle = summarizing ? 'Available when the summary is written.' : interrupts ? 'Stop the running turn and send this message now.' : 'Send this message now.'

  return (
    <section className={`queue ${gate.action === 'hold' ? 'queue--hold' : ''}`} aria-label="Queued messages">
      <div className="queue__head">
        <span className="queue__title">
          <GateIcon gate={gate} />
          Queued
          <span className="queue__count">{queue.length}</span>
        </span>
        <span className="queue__gate" role={gate.action === 'hold' ? 'status' : undefined}>{describeGate(gate)}</span>
      </div>
      <ul className="queue__list">
        {queue.map((item, index) => (
          <li className="queue__row" key={item.id}>
            <span className="queue__n" aria-hidden="true">{index + 1}</span>
            <span className="queue__text" title={item.text.slice(0, 400)}>{item.text || 'Attachments only'}</span>
            {item.attachments.length > 0 && (
              <span className="queue__att" title={plural(item.attachments.length, 'attachment')}>
                <Paperclip size={12} aria-hidden="true" />
                {item.attachments.length}
              </span>
            )}
            <span className="queue__actions">
              <button className="queue__btn" onClick={() => { if (pullIntoComposer(conversationId, item.id)) focusComposer() }} aria-label={`Edit queued message ${index + 1}`} title="Edit in the composer">
                <Pencil size={13} />
              </button>
              <button className="queue__btn" onClick={() => { remove(conversationId, item.id); focusComposer() }} aria-label={`Remove queued message ${index + 1}`} title="Remove">
                <X size={14} />
              </button>
              <button className="btn sm queue__send" disabled={summarizing} onClick={() => { void sendNow(conversationId, item.id); focusComposer() }} aria-label={`Send now, queued message ${index + 1}`} title={sendTitle}>
                <CornerDownLeft size={12} className="queue__send-icon" aria-hidden="true" />
                <span className="queue__send-label">Send now</span>
              </button>
            </span>
          </li>
        ))}
      </ul>
      {queue.length >= QUEUE_LIMIT && <p className="queue__full" role="status">The queue holds {QUEUE_LIMIT} messages. Remove one to add another.</p>}
    </section>
  )
}
