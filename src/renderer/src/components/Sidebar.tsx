import {
  Archive,
  Blocks,
  ChevronUp,
  Cpu,
  Gauge,
  type LucideIcon,
  MessageSquare,
  Package,
  Pin,
  Plug,
  Plus,
  Search,
  Settings,
  Star,
  Trash2
} from 'lucide-react'
import { useStore, type ViewId } from '../state/store'
import { CubexLockup } from '../theme/Logo'
import type { ConversationSummary } from '../../../shared/ipc'

const PRIMARY: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: 'chat', label: 'Chats', icon: MessageSquare },
  { id: 'pinned', label: 'Pinned', icon: Pin },
  { id: 'archive', label: 'Archive', icon: Archive }
]

const WORKSPACE: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'local', label: 'Local Models', icon: Package },
  { id: 'browser', label: 'Model Browser', icon: Search },
  { id: 'hardware', label: 'Hardware', icon: Cpu },
  { id: 'benchmarks', label: 'Benchmarks', icon: Gauge },
  { id: 'presets', label: 'Presets', icon: Star }
]

/** Bucket conversations into Today / Yesterday / Last 7 Days / Older. */
function groupByDate(items: ConversationSummary[]): Array<[string, ConversationSummary[]]> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const weekAgo = startOfToday - 6 * 86_400_000

  const buckets: Record<string, ConversationSummary[]> = {
    Today: [],
    Yesterday: [],
    'Last 7 Days': [],
    Older: []
  }
  for (const c of items) {
    if (c.updatedAt >= startOfToday) buckets['Today']!.push(c)
    else if (c.updatedAt >= startOfYesterday) buckets['Yesterday']!.push(c)
    else if (c.updatedAt >= weekAgo) buckets['Last 7 Days']!.push(c)
    else buckets['Older']!.push(c)
  }
  return Object.entries(buckets).filter(([, v]) => v.length > 0)
}

export function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const conversations = useStore((s) => s.conversations)
  const activeId = useStore((s) => s.activeConversation?.id)
  const openConversation = useStore((s) => s.openConversation)
  const newConversation = useStore((s) => s.newConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)

  const chatLike = view === 'chat' || view === 'pinned' || view === 'archive'
  const groups = groupByDate(conversations)

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <CubexLockup size={20} />
      </div>

      <div className="sidebar__scroll">
        <button className="newchat" onClick={() => void newConversation()}>
          <Plus size={17} strokeWidth={2.2} />
          New Chat
          <span className="newchat__kbd">
            <span className="kbd">Ctrl</span>
            <span className="kbd">N</span>
          </span>
        </button>

        {PRIMARY.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`nav ${view === id ? 'nav--active' : ''}`} onClick={() => setView(id)}>
            <Icon size={17} strokeWidth={1.9} />
            {label}
          </button>
        ))}

        <div className="sidebar__label">Workspace</div>
        {WORKSPACE.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`nav ${view === id ? 'nav--active' : ''}`} onClick={() => setView(id)}>
            <Icon size={17} strokeWidth={1.9} />
            {label}
          </button>
        ))}

        {chatLike &&
          groups.map(([label, items]) => (
            <div key={label}>
              <div className="sidebar__label">{label}</div>
              {items.map((c) => (
                <button
                  key={c.id}
                  className={`convo ${activeId === c.id ? 'convo--active' : ''}`}
                  onClick={() => void openConversation(c.id)}
                  title={c.title}
                >
                  {c.execution === 'local' && <Blocks size={13} style={{ color: 'var(--local)', flexShrink: 0 }} />}
                  <span className="convo__title">{c.title}</span>
                  <span
                    className="convo__act"
                    role="button"
                    tabIndex={-1}
                    aria-label="Delete conversation"
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteConversation(c.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </span>
                </button>
              ))}
            </div>
          ))}

        {chatLike && conversations.length === 0 && (
          <div className="muted" style={{ padding: '18px 12px', fontSize: 12.5 }}>
            No conversations yet.
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        <button className={`nav ${view === 'settings' ? 'nav--active' : ''}`} onClick={() => setView('settings')}>
          <Settings size={17} strokeWidth={1.9} />
          Settings
        </button>
        <button className="userrow">
          <span className="avatar">H</span>
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>Hesham</span>
          <ChevronUp size={15} style={{ marginLeft: 'auto', color: 'var(--text-3)' }} />
        </button>
      </div>
    </aside>
  )
}
