import type { DirEntry } from '../../../shared/ipc'

/** One folder as the tree knows it. */
export interface Listing {
  status: 'loading' | 'ready' | 'error'
  entries: DirEntry[]
  /** Entries past the cap that were not listed. */
  omitted: number
  error?: string
}

export type TreeRow =
  | { kind: 'dir' | 'file'; path: string; name: string; depth: number; open: boolean; hidden: boolean }
  | { kind: 'note'; path: string; depth: number; text: string; tone: 'quiet' | 'error' }

/**
 * The visible rows of the tree, top to bottom: each folder's entries, with an open folder's own
 * entries (or a note while they load, fail or are cut short) right under it.
 */
export function flattenTree(listings: Readonly<Record<string, Listing | undefined>>, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    const listing = listings[dir]
    if (!listing || listing.status === 'loading') {
      rows.push({ kind: 'note', path: `${dir}\0loading`, depth, text: 'Loading', tone: 'quiet' })
      return
    }
    if (listing.status === 'error') {
      rows.push({ kind: 'note', path: `${dir}\0error`, depth, text: listing.error ?? 'This folder could not be read.', tone: 'error' })
      return
    }
    if (listing.entries.length === 0) {
      rows.push({ kind: 'note', path: `${dir}\0empty`, depth, text: dir === '' ? 'This folder is empty.' : 'Empty folder', tone: 'quiet' })
      return
    }
    for (const entry of listing.entries) {
      const open = entry.isDirectory && expanded.has(entry.path)
      rows.push({ kind: entry.isDirectory ? 'dir' : 'file', path: entry.path, name: entry.name, depth, open, hidden: entry.hidden === true })
      if (open) walk(entry.path, depth + 1)
    }
    if (listing.omitted > 0) {
      rows.push({ kind: 'note', path: `${dir}\0omitted`, depth, text: `${listing.omitted.toLocaleString()} more not shown. Search to find them.`, tone: 'quiet' })
    }
  }
  walk('', 0)
  return rows
}

/** Text split around the first place a search matches it (ignoring case), for marking what was typed. */
export function splitMatch(text: string, query: string): [before: string, match: string, after: string] {
  const needle = query.trim().toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  return at < 0 ? [text, '', ''] : [text.slice(0, at), text.slice(at, at + needle.length), text.slice(at + needle.length)]
}
