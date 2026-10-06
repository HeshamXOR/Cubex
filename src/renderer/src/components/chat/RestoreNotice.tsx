import { Check, TriangleAlert, X } from 'lucide-react'
import { describeNotice } from '../../lib/restoreCopy'
import { undoRestore, useRestore } from '../../state/restore'
import { useStore } from '../../state/store'
import './restore.css'

/**
 * What a restore or its undo did, above the composer. It goes away when the thread changes again, because
 * Undo is only safe while nothing has been sent since.
 */
export function RestoreNotice(): JSX.Element | null {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const threadLength = useStore((state) => state.liveMessages.length)
  const notice = useRestore((state) => (conversationId ? state.notices[conversationId] : undefined))
  const dismiss = useRestore((state) => state.dismiss)
  if (!conversationId || !notice || notice.messageCount !== threadLength) return null

  const text = describeNotice({
    kind: notice.kind,
    axes: notice.axes,
    result: notice.result,
    undone: notice.undone,
    error: notice.error,
    composerHasMessage: !!notice.cut?.composer
  })
  const Icon = text.tone === 'ok' ? Check : TriangleAlert
  return (
    <div className={`callout restore-notice restore-notice--${text.tone} ${text.tone === 'error' ? 'callout--error' : text.tone === 'warn' ? 'callout--warn' : ''}`} role={text.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={14} aria-hidden="true" />
      <div className="callout__body">
        <strong>{text.title}</strong>
        {text.summary}
        {text.lists.map((list) => (
          <div key={list.label}>
            <div className="restore-notice__label">{list.label}</div>
            <ul className="restore-notice__files">
              {list.items.map((item) => (
                <li key={item.path}>
                  <span>{item.path}</span>
                  {item.why && <span className="restore-notice__why">{item.why}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="callout__actions">
        {notice.kind === 'restored' && notice.undoId && (
          <button className="callout__action" disabled={notice.undoing} onClick={() => void undoRestore()}>{notice.undoing ? 'Undoing' : 'Undo'}</button>
        )}
        <button className="callout__icon" onClick={() => dismiss(conversationId)} aria-label="Dismiss" title="Dismiss"><X size={14} /></button>
      </div>
    </div>
  )
}
