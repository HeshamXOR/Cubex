import { lstatSync, realpathSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DirEntry } from '@shared/ipc'

const TREE_SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.cache', '.next'])
const MAX_SCAN = 8000
const MAX_RESULTS = 200

/** An explicit task owns its root, including an intentionally missing root. */
export function selectWorkspace(
  selectedWorkspace: string | undefined,
  conversationId: string | undefined,
  getConversation: (id: string) => { workspacePath?: string } | null | undefined
): string | undefined {
  if (conversationId === undefined) return selectedWorkspace
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) {
    throw new Error('Invalid task id.')
  }
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('Task was not found.')
  return conversation.workspacePath
}

function canonicalRoot(workspace: string | undefined): string {
  if (!workspace) throw new Error('No workspace folder selected for this task.')
  const root = realpathSync.native(resolve(workspace))
  if (!lstatSync(root).isDirectory()) throw new Error('The workspace must be a folder.')
  return root
}

function isWithin(root: string, candidate: string): boolean {
  // relative handles Windows case-insensitivity, drive roots and UNC paths;
  // prefix comparisons do not (e.g. C:\\ + separator, or sibling "project-2").
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Existing UI paths must remain inside the selected root lexically and physically. */
export function resolveWorkspacePath(workspace: string | undefined, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length > 4096 || relPath.includes('\0')) throw new Error('Invalid workspace path.')
  const root = canonicalRoot(workspace)
  const candidate = resolve(root, relPath || '.')
  if (!isWithin(root, candidate)) throw new Error('Path escapes the workspace.')
  const real = realpathSync.native(candidate)
  if (!isWithin(root, real)) throw new Error('Path escapes the workspace.')
  return real
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.') || TREE_SKIP.has(name)
}

/** What a listing shows: nothing hidden, dot-names too (search), or everything including ignored folders (the tree). */
type Exposure = 'visible' | 'dotfiles' | 'all'

function listable(entry: Dirent, exposure: Exposure = 'visible'): boolean {
  const named = exposure === 'all' || (exposure === 'dotfiles' ? !TREE_SKIP.has(entry.name) : !isHiddenName(entry.name))
  return named && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())
}

export interface BrowseOptions {
  /** Also list dot-names and, in a folder listing, ignored folders such as node_modules. */
  showHidden?: boolean
}

/** Lazy explorer listing. Symlinks/junctions never become clickable tree entries. */
export async function readWorkspaceDirectory(workspace: string | undefined, relPath = '.', options: BrowseOptions = {}): Promise<DirEntry[]> {
  const root = canonicalRoot(workspace)
  const path = resolveWorkspacePath(root, relPath)
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter((entry) => listable(entry, options.showHidden ? 'all' : 'visible')).map((entry) => ({
    name: entry.name,
    path: relative(root, join(path, entry.name)).split(sep).join('/'),
    isDirectory: entry.isDirectory(),
    ...(isHiddenName(entry.name) ? { hidden: true } : {})
  })).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
}

/** Bounded, read-only file autocomplete for one task's workspace. */
export async function searchWorkspaceEntries(workspace: string | undefined, query: string, limit = 50, options: BrowseOptions = {}): Promise<DirEntry[]> {
  if (typeof query !== 'string' || query.length > 4096) throw new Error('Invalid workspace search query.')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error(`Search limit must be between 1 and ${MAX_RESULTS}.`)
  if (!workspace) return []
  const root = canonicalRoot(workspace)
  const exposure: Exposure = options.showHidden ? 'dotfiles' : 'visible'
  const q = query.toLowerCase()
  const out: DirEntry[] = []
  const queue = ['']
  let scanned = 0
  while (queue.length && out.length < limit * 6 && scanned < MAX_SCAN) {
    const dir = queue.shift()!
    let entries: Dirent[]
    try {
      // Recheck queued directories before opening them: a renamed directory
      // cannot turn autocomplete into a walk through an external junction.
      entries = await readdir(resolveWorkspacePath(root, dir), { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (scanned++ >= MAX_SCAN || out.length >= limit * 6) break
      if (!listable(entry, exposure)) continue
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) queue.push(path)
      else if (!q || path.toLowerCase().includes(q)) out.push({ name: entry.name, path, isDirectory: false, ...(path.split('/').some(isHiddenName) ? { hidden: true } : {}) })
    }
  }
  out.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1
    const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1
    return aPrefix - bPrefix || a.path.length - b.path.length || a.path.localeCompare(b.path)
  })
  return out.slice(0, limit)
}
