import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Cpu,
  Download,
  FileText,
  Gauge,
  Keyboard,
  type LucideIcon,
  MessageSquare,
  Plug,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen
} from 'lucide-react'
import { useStore, type ViewId } from '../state/store'
import { api } from '../lib/api'
import { basename, shortTime } from '../lib/format'
import { shortcutHint } from '../lib/shortcuts'
import { useShortcutSheet } from '../state/shortcutSheet'
import { useUpdates } from '../state/updates'
import type { DirEntry } from '../../../shared/ipc'
import { openSettingsPage } from '../lib/settingsLink'
import { SETTINGS_PAGES } from '../views/settings/pages'

type Group = 'Sessions' | 'Files' | 'Go to' | 'Actions'

interface Item {
  id: string
  group: Group
  label: string
  hint?: string
  icon: LucideIcon
  /** Words that find this item without showing. */
  keywords?: string
  /** Left out of the list until something is typed. */
  searchOnly?: boolean
  run: () => void
}

const ORDER: Group[] = ['Actions', 'Sessions', 'Files', 'Go to']
const ORDER_SEARCHING: Group[] = ['Sessions', 'Files', 'Go to', 'Actions']

/**
 * Search and commands (Ctrl+K): sessions, files in the project and the places you can
 * go. Keyboard first: arrows move, Enter runs, Esc closes.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const conversations = useStore((s) => s.conversations)
  const conversationId = useStore((s) => s.activeConversation?.id)
  const workspace = useStore((s) => s.settings?.general.workspacePath)
  const openConversation = useStore((s) => s.openConversation)
  const newConversation = useStore((s) => s.newConversation)
  const appendToComposer = useStore((s) => s.appendToComposer)
  const setView = useStore((s) => s.setView)
  const update = useUpdates((s) => s.state.update)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [files, setFiles] = useState<DirEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setFiles([])
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Files in the open project, once there is something to search for.
  useEffect(() => {
    const query = q.trim()
    if (!open || !workspace || query.length < 2) {
      setFiles([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      api.searchWorkspaceFiles(query, 8, conversationId).then((found) => { if (alive) setFiles(found) }).catch(() => { if (alive) setFiles([]) })
    }, 90)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [q, open, workspace, conversationId])

  const items = useMemo<Item[]>(() => {
    const place = (id: ViewId, label: string, icon: LucideIcon): Item => ({ id: `v-${id}`, group: 'Go to', label, icon, run: () => setView(id) })
    const actions: Item[] = [
      { id: 'new', group: 'Actions', label: 'New session', hint: shortcutHint('newSession'), icon: SquarePen, run: () => void newConversation() },
      { id: 'shortcuts', group: 'Actions', label: 'Keyboard shortcuts', hint: shortcutHint('shortcuts'), icon: Keyboard, run: () => useShortcutSheet.getState().setOpen(true) },
      ...(update && !update.skipped
        ? [{ id: 'update', group: 'Actions' as const, label: `What's new in Cubex ${update.info.version}`, hint: update.stage === 'ready' ? 'Ready to restart' : 'Update available', icon: Download, run: () => useUpdates.getState().openDialog() }]
        : []),
      { id: 'check-updates', group: 'Actions', label: 'Check for updates', keywords: 'update version release new', searchOnly: true, icon: Download, run: () => { openSettingsPage('updates'); void useUpdates.getState().check() } }
    ]
    const places: Item[] = [
      place('providers', 'Providers', Plug),
      place('local', 'Local models', Cpu),
      place('hardware', 'Hardware', Gauge),
      place('presets', 'Presets', SlidersHorizontal),
      place('settings', 'Settings', Settings)
    ]
    // A page of Settings is found by what is on it, so a search for "retry" or "agy" lands on the page.
    const settingsPages: Item[] = SETTINGS_PAGES.map((page) => ({
      id: `s-${page.id}`,
      group: 'Go to' as const,
      label: page.label,
      hint: 'Settings',
      keywords: `${page.keywords} ${page.description}`,
      searchOnly: true,
      icon: page.icon,
      run: () => openSettingsPage(page.id)
    }))
    const sessions: Item[] = conversations
      .filter((c) => !c.archived)
      .slice(0, 80)
      .map((c) => ({
        id: c.id,
        group: 'Sessions' as const,
        label: c.title,
        hint: `${c.workspacePath ? `${basename(c.workspacePath)}  ` : ''}${shortTime(c.updatedAt)}`.trim(),
        icon: MessageSquare,
        run: () => void openConversation(c.id)
      }))
    const mentions: Item[] = files.map((file) => ({
      id: `f-${file.path}`,
      group: 'Files' as const,
      label: file.name,
      hint: file.path,
      icon: FileText,
      run: () => {
        setView('chat')
        appendToComposer(`@${file.path}`)
      }
    }))
    return [...actions, ...sessions.slice(0, q.trim() ? 80 : 8), ...mentions, ...places, ...settingsPages]
  }, [conversations, files, q, update, newConversation, openConversation, setView, appendToComposer])

  const grouped = useMemo(() => {
    const query = q.trim().toLowerCase()
    const matches = query
      ? items.filter((item) => item.group === 'Files' || item.label.toLowerCase().includes(query) || (item.hint ?? '').toLowerCase().includes(query) || (item.keywords ?? '').toLowerCase().includes(query))
      : items.filter((item) => item.group !== 'Files' && !item.searchOnly)
    const order = query ? ORDER_SEARCHING : ORDER
    return order.map((group) => ({ group, items: matches.filter((item) => item.group === group) })).filter((entry) => entry.items.length > 0)
  }, [items, q])

  const flat = useMemo(() => grouped.flatMap((entry) => entry.items), [grouped])

  if (!open) return null

  const activate = (item: Item | undefined): void => {
    if (!item) return
    item.run()
    onClose()
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((n) => Math.min(n + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((n) => Math.max(n - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(flat[idx])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let position = -1
  return (
    <div className="cmdk" onClick={onClose}>
      <div className="cmdk__panel" role="dialog" aria-label="Search sessions, files and commands" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk__search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search sessions, files and commands"
            spellCheck={false}
            aria-label="Search"
            onChange={(e) => {
              setQ(e.target.value)
              setIdx(0)
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="cmdk__list" role="listbox">
          {flat.length === 0 && <div className="cmdk__empty">Nothing matches that.</div>}
          {grouped.map((entry) => (
            <div key={entry.group} role="group" aria-label={entry.group}>
              <div className="cmdk__group">{entry.group}</div>
              {entry.items.map((item) => {
                position++
                const index = position
                return (
                  <button
                    key={item.id}
                    className={`cmdk__item ${index === idx ? 'is-active' : ''}`}
                    role="option"
                    aria-selected={index === idx}
                    onMouseEnter={() => setIdx(index)}
                    onClick={() => activate(item)}
                  >
                    <item.icon size={15} />
                    <span className="cmdk__label">{item.label}</span>
                    {item.hint && <span className="cmdk__hint">{item.hint}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="cmdk__foot">
          <span><kbd>Enter</kbd>open</span>
          <span><kbd>Esc</kbd>close</span>
        </div>
      </div>
    </div>
  )
}
