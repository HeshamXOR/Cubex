import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { SessionFileChange } from '../../../../shared/ipc'
import { iconFor } from '../../lib/fileKinds'
import { flattenTree, type TreeRow } from '../../lib/fileTree'
import { useVirtualWindow } from '../../lib/useVirtualWindow'
import { useFiles } from '../../state/files'
import { Stat } from '../ChangeStat'

const ROW_HEIGHT = 28

const rowId = (path: string): string => `fx-row-${path}`

interface RowProps {
  row: Exclude<TreeRow, { kind: 'note' }>
  selected: boolean
  active: boolean
  change: SessionFileChange | undefined
  onActivate: (row: Exclude<TreeRow, { kind: 'note' }>) => void
}

const Row = memo(function Row({ row, selected, active, change, onActivate }: RowProps): JSX.Element {
  const Icon = row.kind === 'dir' ? (row.open ? FolderOpen : Folder) : iconFor(row.name)
  return (
    <div
      role="treeitem"
      id={rowId(row.path)}
      className="fx-row"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === 'dir' ? row.open : undefined}
      aria-selected={selected}
      data-active={active || undefined}
      data-hidden={row.hidden || undefined}
      style={{ '--depth': row.depth } as CSSProperties}
      onClick={() => onActivate(row)}
    >
      {row.kind === 'dir' ? <ChevronRight size={14} className="fx-chev" data-open={row.open} aria-hidden="true" /> : <span className="fx-chev" aria-hidden="true" />}
      <Icon size={15} aria-hidden="true" />
      <span className="fx-name" title={row.path}>{row.name}</span>
      {change && <Stat added={change.added} removed={change.removed} />}
    </div>
  )
})

/** The project as folders and files. Folders open on demand; the keyboard works like any tree. */
export function FileTree({ changes }: { changes: ReadonlyMap<string, SessionFileChange> }): JSX.Element {
  const listings = useFiles((state) => state.listings)
  const expanded = useFiles((state) => state.expanded)
  const selected = useFiles((state) => state.selected)
  const cursor = useFiles((state) => state.cursor)
  const focus = useFiles((state) => state.focus)
  const toggle = useFiles((state) => state.toggle)
  const select = useFiles((state) => state.select)
  const setCursor = useFiles((state) => state.setCursor)

  const rows = useMemo(() => flattenTree(listings, new Set(Object.keys(expanded))), [listings, expanded])
  const scroller = useRef<HTMLDivElement>(null)
  const { start, end, height, reveal } = useVirtualWindow(scroller, { count: rows.length, rowHeight: ROW_HEIGHT, overscan: 10 })

  // Asking to look at something (a path link, a search hit) scrolls it into the middle once it is listed.
  const handled = useRef(focus)
  useEffect(() => {
    if (focus === handled.current || !cursor) return
    const index = rows.findIndex((row) => row.kind !== 'note' && row.path === cursor)
    if (index < 0) return
    handled.current = focus
    reveal(index, 'center')
  }, [focus, cursor, rows, reveal])

  const activate = useCallback((row: Exclude<TreeRow, { kind: 'note' }>) => {
    setCursor(row.path)
    if (row.kind === 'dir') toggle(row.path)
    else void select(row.path)
  }, [setCursor, toggle, select])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const real = rows.map((row, index) => ({ row, index })).filter((entry): entry is { row: Exclude<TreeRow, { kind: 'note' }>; index: number } => entry.row.kind !== 'note')
    if (!real.length) return
    const at = Math.max(0, real.findIndex((entry) => entry.row.path === cursor))
    const current = real[at]!
    const moveTo = (target: number): void => {
      const next = real[Math.min(real.length - 1, Math.max(0, target))]!
      setCursor(next.row.path)
      reveal(next.index)
    }
    switch (event.key) {
      case 'ArrowDown': moveTo(at + 1); break
      case 'ArrowUp': moveTo(at - 1); break
      case 'Home': moveTo(0); break
      case 'End': moveTo(real.length - 1); break
      case 'PageDown': moveTo(at + 10); break
      case 'PageUp': moveTo(at - 10); break
      case 'ArrowRight':
        if (current.row.kind === 'dir') {
          if (!current.row.open) toggle(current.row.path)
          else moveTo(at + 1)
        }
        break
      case 'ArrowLeft':
        if (current.row.kind === 'dir' && current.row.open) toggle(current.row.path)
        else {
          const parent = [...real.slice(0, at)].reverse().find((entry) => entry.row.kind === 'dir' && entry.row.depth === current.row.depth - 1)
          if (parent) moveTo(real.indexOf(parent))
        }
        break
      case 'Enter':
      case ' ':
        activate(current.row)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const activeRow = cursor && rows.some((row) => row.kind !== 'note' && row.path === cursor) ? rowId(cursor) : undefined
  // A tree needs items: while the listing loads, fails or is empty there is only a note, so the list is a plain group.
  const hasItems = rows.some((row) => row.kind !== 'note')

  return (
    <div
      ref={scroller}
      className="fx-list"
      role={hasItems ? 'tree' : 'group'}
      aria-label="Project files"
      tabIndex={hasItems ? 0 : undefined}
      aria-activedescendant={activeRow}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // Landing on the list with the keyboard starts at the open file, or the first row.
        if (event.target !== event.currentTarget || cursor) return
        const first = rows.find((row) => row.kind !== 'note')
        setCursor(selected ?? first?.path)
      }}
    >
      <div className="fx-list__sizer" style={{ height }}>
        <div className="fx-list__rows" style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {rows.slice(start, end).map((row) => (row.kind === 'note'
            ? <div key={row.path} className="fx-note" data-tone={row.tone} style={{ '--depth': row.depth } as CSSProperties} role="presentation">{row.text}</div>
            : <Row key={row.path} row={row} selected={row.path === selected} active={row.path === cursor} change={row.kind === 'file' ? changes.get(row.path) : undefined} onActivate={activate} />))}
        </div>
      </div>
    </div>
  )
}
