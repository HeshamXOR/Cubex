import { Archive, MessageSquare, Pin } from 'lucide-react'
import { useStore } from '../state/store'
import { relativeTime } from '../lib/api'

/**
 * Pinned / Archive listings. Both read the same conversation store; pinning and
 * archiving are not yet persisted flags, so these currently present the full
 * conversation list with a clear note rather than pretending to filter.
 */
export function ListView({ kind }: { kind: 'pinned' | 'archive' }): JSX.Element {
  const conversations = useStore((s) => s.conversations)
  const open = useStore((s) => s.openConversation)

  const Icon = kind === 'pinned' ? Pin : Archive
  const title = kind === 'pinned' ? 'Pinned' : 'Archive'

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">{title}</div>
        <div className="view__sub">
          {kind === 'pinned'
            ? 'Conversations you mark as pinned will appear here. Pin state is not persisted yet — this lists all conversations for now.'
            : 'Archived conversations. Archiving is not persisted yet — this lists all conversations for now.'}
        </div>

        {conversations.length === 0 ? (
          <div className="empty">
            <Icon size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div>No conversations yet.</div>
          </div>
        ) : (
          <div className="grid">
            {conversations.map((c) => (
              <button key={c.id} className="card card--row" onClick={() => void open(c.id)} style={{ textAlign: 'left' }}>
                <div className="row" style={{ minWidth: 0 }}>
                  <MessageSquare size={16} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.title}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                      {c.messageCount} messages · {relativeTime(c.updatedAt)} · {c.model ?? 'no model'}
                    </div>
                  </div>
                </div>
                <span className={`badge badge--${c.execution === 'local' ? 'local' : 'cloud'}`}>
                  <span className="dot" />
                  {c.execution.toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
