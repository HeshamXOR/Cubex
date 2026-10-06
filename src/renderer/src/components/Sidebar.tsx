import { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  FolderOpen,
  FolderPlus,
  Gauge,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  ShieldQuestion,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import { selectableProvider, useStore, type ViewId } from '../state/store'
import { basename, shortTime } from '../lib/format'
import { useSessionStates, type SessionState } from '../lib/useSessionStates'
import { CubexMark } from '../theme/Logo'
import type { ConversationSummary } from '../../../shared/ipc'
import { InlineRename } from './InlineRename'
import { UsageButton } from './UsageButton'

/** Sessions shown under a project before "Show more". */
const GROUP_LIMIT = 8

interface FolderGroup {
  key: string
  label: string
  path?: string
  items: ConversationSummary[]
}

/** Group sessions under their project folder; the active project floats first. */
function groupByFolder(items: ConversationSummary[], active?: string): FolderGroup[] {
  const map = new Map<string, ConversationSummary[]>()
  for (const conversation of items) {
    const key = conversation.workspacePath ?? ''
    const bucket = map.get(key)
    if (bucket) bucket.push(conversation)
    else map.set(key, [conversation])
  }
  // The active project always shows, even before it has any sessions.
  if (active && !map.has(active)) map.set(active, [])
  const groups: FolderGroup[] = [...map.entries()].map(([key, list]) => ({
    key,
    label: key ? basename(key) : 'No project',
    path: key || undefined,
    items: list.sort((a, b) => b.updatedAt - a.updatedAt)
  }))
  groups.sort((a, b) => {
    if (active && a.key === active) return -1
    if (active && b.key === active) return 1
    if (!a.key) return 1
    if (!b.key) return -1
    return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)
  })
  return groups
}

/** The identity glyphs: the turning star is working, the amber shield asks for you. Quiet sessions show nothing. */
function StateMark({ state }: { state: SessionState | undefined }): JSX.Element {
  if (state === 'running') return <span className="st" title="Working"><CubexMark size={12} className="mark turning" /></span>
  if (state === 'waiting') return <span className="st" title="Needs you"><ShieldQuestion size={13} className="wait" /></span>
  return <span className="st" />
}

const MORE_VIEWS: Array<{ id: ViewId; label: string; icon: typeof Gauge }> = [
  { id: 'hardware', label: 'Hardware', icon: Gauge },
  { id: 'presets', label: 'Presets', icon: SlidersHorizontal }
]

export function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const conversations = useStore((s) => s.conversations)
  const activeId = useStore((s) => s.activeConversation?.id)
  const openConversation = useStore((s) => s.openConversation)
  const newConversation = useStore((s) => s.newConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)
  const togglePin = useStore((s) => s.togglePin)
  const toggleArchive = useStore((s) => s.toggleArchive)
  const renameConversation = useStore((s) => s.renameActiveConversation)
  const workspace = useStore((s) => s.settings?.general.workspacePath)
  const recentWorkspaces = useStore((s) => s.settings?.general.recentWorkspaces)
  const pickWorkspace = useStore((s) => s.pickWorkspace)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const clearWorkspace = useStore((s) => s.clearWorkspace)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const states = useSessionStates()

  const [projectMenu, setProjectMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string>()

  const live = conversations.filter((c) => !c.archived)
  const pinned = live.filter((c) => c.pinned)
  const groups = useMemo(() => groupByFolder(live.filter((c) => !c.pinned), workspace), [live, workspace])
  const archived = conversations.filter((c) => c.archived)
  const recents = (recentWorkspaces ?? []).filter((path) => path !== workspace)
  const connected = providers.filter((provider) => selectableProvider(provider, settings)).length
  const activeGroup = conversations.find((c) => c.id === activeId)?.workspacePath ?? ''

  const isOpen = (group: FolderGroup): boolean => open[group.key] ?? (group.key === activeGroup || group.key === (workspace ?? '') || groups.length <= 3)
  const toggle = (group: FolderGroup): void => setOpen((current) => ({ ...current, [group.key]: !isOpen(group) }))

  const startInProject = async (path: string): Promise<void> => {
    await setWorkspace(path)
    await newConversation()
  }

  const Row = (conversation: ConversationSummary): JSX.Element => {
    const current = activeId === conversation.id && view === 'chat'
    const editing = editingId === conversation.id
    return (
      <div className={`sess ${current ? 'cur' : ''} ${menuFor === conversation.id ? 'is-menu' : ''}`} key={conversation.id}>
        {editing ? (
          <>
            <span className="st" />
            <InlineRename
              value={conversation.title}
              onSave={(title) => renameConversation(conversation.id, title)}
              onClose={() => setEditingId((id) => (id === conversation.id ? undefined : id))}
            />
          </>
        ) : (
          <>
            <button className="sess-open" onClick={() => void openConversation(conversation.id)} title={conversation.title} aria-current={current ? 'page' : undefined}>
              <StateMark state={states[conversation.id]} />
              <span className="nm">{conversation.title}</span>
            </button>
            <time dateTime={new Date(conversation.updatedAt).toISOString()}>{shortTime(conversation.updatedAt)}</time>
            <button
              className="sess-act"
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={menuFor === conversation.id}
              onClick={(event) => {
                event.stopPropagation()
                setMenuFor((id) => (id === conversation.id ? null : conversation.id))
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          </>
        )}
        {menuFor === conversation.id && (
          <>
            <div className="backdrop" onClick={() => setMenuFor(null)} />
            <div className="menu sess-menu" role="menu">
              <button className="menu__item" role="menuitem" onClick={() => { void togglePin(conversation.id); setMenuFor(null) }}>
                {conversation.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                <span className="menu__t">{conversation.pinned ? 'Unpin' : 'Pin to top'}</span>
              </button>
              <button className="menu__item" role="menuitem" onClick={() => { setMenuFor(null); setEditingId(conversation.id) }}>
                <Pencil size={15} />
                <span className="menu__t">Rename</span>
              </button>
              <button className="menu__item" role="menuitem" onClick={() => { void toggleArchive(conversation.id); setMenuFor(null) }}>
                <Archive size={15} />
                <span className="menu__t">Archive</span>
              </button>
              <div className="menu__sep" />
              <button className="menu__item menu__item--danger" role="menuitem" onClick={() => { void deleteConversation(conversation.id); setMenuFor(null) }}>
                <Trash2 size={15} />
                <span className="menu__t">Delete</span>
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  const rows = (group: FolderGroup): JSX.Element[] => {
    const all = expanded.has(group.key)
    const shown = all ? group.items : group.items.slice(0, GROUP_LIMIT)
    const out = shown.map(Row)
    if (!all && group.items.length > GROUP_LIMIT) {
      out.push(
        <button className="proj" key={`${group.key}:more`} onClick={() => setExpanded((set) => new Set(set).add(group.key))}>
          <span className="nm">Show {group.items.length - GROUP_LIMIT} more</span>
        </button>
      )
    }
    return out
  }

  return (
    <nav
      className="side"
      aria-label="Sessions"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (projectMenu || menuFor || moreOpen)) {
          event.stopPropagation()
          setProjectMenu(false)
          setMenuFor(null)
          setMoreOpen(false)
        }
      }}
    >
      <button className="side-new" onClick={() => void newConversation()}>
        <SquarePen size={15} />
        New session
        <kbd>Ctrl N</kbd>
      </button>

      <div className="side-label pos-rel">
        <span>Projects</span>
        <button className="side-label__add" onClick={() => setProjectMenu((v) => !v)} aria-label="Open a project" aria-haspopup="menu" aria-expanded={projectMenu} title="Open a project folder">
          <Plus size={15} />
        </button>
        {projectMenu && (
          <>
            <div className="backdrop" onClick={() => setProjectMenu(false)} />
            <div className="menu" style={{ top: 28, left: 0, right: 0, minWidth: 0 }} role="menu">
              {workspace && (
                <div className="menu__path">{workspace}</div>
              )}
              {recents.length > 0 && <div className="menu__label">Recent</div>}
              {recents.slice(0, 6).map((path) => (
                <button key={path} className="menu__item" role="menuitem" title={path} onClick={() => { void setWorkspace(path); setProjectMenu(false) }}>
                  <FolderOpen size={15} />
                  <span className="menu__t">{basename(path)}</span>
                </button>
              ))}
              {recents.length > 0 && <div className="menu__sep" />}
              <button className="menu__item" role="menuitem" onClick={() => { void pickWorkspace(); setProjectMenu(false) }}>
                <FolderPlus size={15} />
                <span className="menu__t">Open folder…</span>
              </button>
              {workspace && (
                <button className="menu__item" role="menuitem" onClick={() => { void clearWorkspace(); setProjectMenu(false) }}>
                  <X size={15} />
                  <span className="menu__t">Close project</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="side-scroll">
        {pinned.length > 0 && (
          <div>
            <div className="proj" style={{ cursor: 'default' }}>
              <Pin size={14} />
              <span className="nm">Pinned</span>
              <span className="n">{pinned.length}</span>
            </div>
            {pinned.map(Row)}
          </div>
        )}

        {groups.map((group) => {
          const expandedGroup = isOpen(group)
          const isWorkspace = group.key === (workspace ?? '') && !!group.key
          return (
            <div key={group.key || '__none__'}>
              <button className="proj" onClick={() => toggle(group)} title={group.path ?? 'Sessions that are not tied to a project folder'} aria-expanded={expandedGroup}>
                {expandedGroup ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {isWorkspace ? <b className="nm">{group.label}</b> : <span className="nm">{group.label}</span>}
                <span className="n">{group.items.length}</span>
              </button>
              {expandedGroup && (group.items.length ? rows(group) : (
                <div className="side-empty">
                  No sessions yet.{' '}
                  {group.path && <button className="proj" style={{ display: 'inline', width: 'auto', padding: 0, height: 'auto', color: 'var(--color-accent-foreground)' }} onClick={() => void startInProject(group.path!)}>Start one</button>}
                </div>
              ))}
            </div>
          )
        })}

        {live.length === 0 && groups.every((group) => group.items.length === 0) && (
          <div className="side-empty">
            {workspace ? 'Start a session to work in this project.' : 'Open a project folder to start, or begin a session without one.'}
          </div>
        )}

        {archived.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button className="proj" onClick={() => setArchivedOpen((v) => !v)} aria-expanded={archivedOpen}>
              {archivedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Archive size={14} />
              <span className="nm">Archived</span>
              <span className="n">{archived.length}</span>
            </button>
            {archivedOpen && archived.map((conversation) => (
              <div className="sess" key={conversation.id}>
                <button className="sess-open" onClick={() => void openConversation(conversation.id)} title={conversation.title}>
                  <span className="st"><MessageSquare size={12} /></span>
                  <span className="nm">{conversation.title}</span>
                </button>
                <button className="sess-act" style={{ display: 'grid' }} title="Unarchive" aria-label="Unarchive session" onClick={() => void toggleArchive(conversation.id)}>
                  <ArchiveRestore size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="side-foot">
        <UsageButton />
        <button className={`side-link ${view === 'providers' ? 'on' : ''}`} onClick={() => setView('providers')} aria-current={view === 'providers' ? 'page' : undefined}>
          <Cloud size={15} />
          Providers
          <span className="tag">{connected > 0 ? `${connected} connected` : 'Set up'}</span>
        </button>
        <button className={`side-link ${view === 'local' ? 'on' : ''}`} onClick={() => setView('local')} aria-current={view === 'local' ? 'page' : undefined}>
          <Cpu size={15} />
          Local models
        </button>
        <div className="side-more">
          <button className={`side-link ${MORE_VIEWS.some((item) => item.id === view) ? 'on' : ''}`} onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen}>
            <MoreHorizontal size={15} />
            More
          </button>
          {moreOpen && (
            <>
              <div className="backdrop" onClick={() => setMoreOpen(false)} />
              <div className="menu" role="menu">
                {MORE_VIEWS.map(({ id, label, icon: Icon }) => (
                  <button key={id} className={`menu__item ${view === id ? 'menu__item--sel' : ''}`} role="menuitem" onClick={() => { setView(id); setMoreOpen(false) }}>
                    <Icon size={15} />
                    <span className="menu__t">{label}</span>
                    {view === id && <Check size={15} className="menu__check" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className={`side-link ${view === 'settings' ? 'on' : ''}`} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}>
          <Settings size={15} />
          Settings
        </button>
      </div>
    </nav>
  )
}
