import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { GitIgnore } from './gitignore'

/** Entries printed per listing; the rest are counted, not shown. */
export const MAX_LISTED_ENTRIES = 500
/** Entries read from one folder before listing stops (flat folders can hold hundreds of thousands). */
export const MAX_SCANNED_ENTRIES = 20_000

// One collator: String#localeCompare builds a new one per call, which is slow on large folders.
const collator = new Intl.Collator()

export interface DirectoryListing {
  /** Folders first (with a trailing slash), then files, each group in locale order, at most MAX_LISTED_ENTRIES. */
  lines: string[]
  /** Entries left out because a .gitignore rule matches them. */
  ignored: number
  /** Visible entries beyond the cap. */
  omitted: number
  /** The folder holds more entries than were read, so `omitted` is only a lower bound. */
  scanLimited: boolean
}

/** List one folder for the model: honors .gitignore, hides always-skipped names, and caps the output. */
export async function listDirectory(options: {
  root: string
  dir: string
  ignore: GitIgnore
  /** Names (folders or files) never listed. Compared case-insensitively on Windows. */
  skipNames: ReadonlySet<string>
  signal?: AbortSignal
}): Promise<DirectoryListing> {
  const { root, dir, ignore, skipNames, signal } = options
  const posix = (path: string): string => relative(root, path).split(sep).join('/')
  const hidden = (name: string): boolean => skipNames.has(process.platform === 'win32' ? name.toLowerCase() : name)
  signal?.throwIfAborted()
  await ignore.load(posix(dir))
  const handle = await fs.opendir(dir)
  const folders: string[] = []
  const files: string[] = []
  let ignored = 0
  let scanned = 0
  let scanLimited = false
  for await (const entry of handle) {
    signal?.throwIfAborted()
    if (++scanned > MAX_SCANNED_ENTRIES) { scanLimited = true; break }
    if (hidden(entry.name)) continue
    const isDirectory = entry.isDirectory()
    if (ignore.ignores(posix(join(dir, entry.name)), isDirectory)) { ignored++; continue }
    if (isDirectory) folders.push(entry.name)
    else files.push(entry.name)
  }
  folders.sort(collator.compare)
  files.sort(collator.compare)
  const all = [...folders.map((name) => `${name}/`), ...files]
  return { lines: all.slice(0, MAX_LISTED_ENTRIES), ignored, omitted: Math.max(0, all.length - MAX_LISTED_ENTRIES), scanLimited }
}

/** The text of a listing, with a short notice for whatever was left out. */
export function formatListing(listing: DirectoryListing): string {
  const entries = (count: number): string => `${count} ${count === 1 ? 'entry' : 'entries'}`
  const body = listing.lines.length ? listing.lines : [listing.ignored || listing.scanLimited ? '(no entries to show)' : '(empty)']
  const notices: string[] = []
  if (listing.scanLimited) {
    const cut = listing.omitted ? `, and ${listing.omitted} of those are not shown` : ''
    notices.push(`This folder has more than ${MAX_SCANNED_ENTRIES} entries; only the first ${MAX_SCANNED_ENTRIES} were read${cut}, so the listing is incomplete. Narrow it: list a subfolder, or use glob_files with a pattern.`)
  } else if (listing.omitted) {
    notices.push(`${listing.omitted} more ${listing.omitted === 1 ? 'entry' : 'entries'} not shown. Narrow it: list a subfolder, or use glob_files with a pattern.`)
  }
  if (listing.ignored) notices.push(`${entries(listing.ignored)} hidden by .gitignore. List an ignored folder directly to see inside it.`)
  return notices.length ? [...body, '', ...notices].join('\n') : body.join('\n')
}
