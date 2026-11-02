import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { GitIgnore } from '../tools/gitignore'

/**
 * A listing of a project folder, taken before and after a delegated task, so that what the agent changed can be told from
 * what Cubex saw it ask about. An agent is held to the policy only for what it asks about: a command it runs, or an edit it
 * makes without asking, comes through only here. The listing holds a name, a size and a modification time for each file,
 * never contents, and skips git's data, `node_modules` and the build-output folders that git ignores (or, outside a repository, the large ones),
 * which a task changes as a matter of course.
 */

/** Never listed: git's own data, and the packages a task installs as a matter of course. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules'])

/**
 * Folders that builds, caches and tools fill. They are skipped only when the project says they are not its own work:
 * git ignores them, or there is no git repository and the folder is large. A project that keeps a `build` or `release`
 * folder under version control has changes there that the person needs to see.
 */
const OUTPUT_FOLDERS = new Set([
  'dist', 'build', 'out', 'release', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '.parcel-cache', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.venv', 'venv', '.gradle', '.idea', '.vs', 'vendor'
])

/** A folder outside a git repository with at least this many files in it counts as large. */
export const LARGE_FOLDER_FILES = 1_000

export const MANIFEST_MAX_FILES = 20_000
export const MANIFEST_MAX_MS = 4_000
const AT_ONCE = 64

export interface Manifest {
  /** Path from the folder, with forward slashes, to "size:modified". */
  files: Map<string, string>
  /** False when the folder was too big or too slow to list in full: what is missing is unknown, not unchanged. */
  complete: boolean
}

export interface ManifestOptions {
  maxFiles?: number
  maxMs?: number
  /** How many files make an output folder large when there is no git repository. Default 1,000. */
  largeFolderFiles?: number
}

async function isRepository(root: string): Promise<boolean> {
  try { await fs.lstat(join(root, '.git')); return true } catch { return false }
}

/** Whether a folder holds at least `limit` files, counting no further than that. */
async function holdsAtLeast(folder: string, limit: number): Promise<boolean> {
  let count = 0
  const pending = [folder]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries: Dirent[]
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(current, entry.name))
      else if (++count >= limit) return true
    }
  }
  return false
}

export async function takeManifest(root: string, options: ManifestOptions = {}): Promise<Manifest> {
  const maxFiles = options.maxFiles ?? MANIFEST_MAX_FILES
  const deadline = Date.now() + (options.maxMs ?? MANIFEST_MAX_MS)
  const files = new Map<string, string>()
  let complete = true
  const folders: string[] = ['']
  const repository = await isRepository(root)
  const ignore = repository ? new GitIgnore(root) : undefined
  const largeAt = options.largeFolderFiles ?? LARGE_FOLDER_FILES
  /** Whether an output folder is left out: git ignores it, or (no repository) it is large. */
  const skipOutput = async (parent: string, path: string, hasIgnoreFile: boolean): Promise<boolean> => {
    if (ignore) {
      try { await ignore.load(parent, hasIgnoreFile) } catch { return false }
      return ignore.ignores(path, true)
    }
    return holdsAtLeast(join(root, path), largeAt)
  }

  while (folders.length > 0) {
    if (Date.now() > deadline) { complete = false; break }
    const batch = folders.splice(0, AT_ONCE)
    const listings = await Promise.all(batch.map(async (folder): Promise<[string, Dirent[]]> => {
      try { return [folder, await fs.readdir(join(root, folder), { withFileTypes: true })] } catch { return [folder, []] }
    }))
    const found: Array<{ path: string }> = []
    for (const [folder, entries] of listings) {
      const hasIgnoreFile = entries.some((entry) => entry.name === '.gitignore')
      for (const entry of entries) {
        const path = folder ? `${folder}/${entry.name}` : entry.name
        // A link is listed as a file and never followed, so a link to somewhere else cannot widen the listing.
        if (!entry.isDirectory()) found.push({ path })
        else if (ALWAYS_SKIP.has(entry.name)) continue
        else if (OUTPUT_FOLDERS.has(entry.name) && await skipOutput(folder, path, hasIgnoreFile)) continue
        else folders.push(path)
      }
    }
    for (let start = 0; start < found.length; start += AT_ONCE) {
      if (files.size >= maxFiles || Date.now() > deadline) { complete = false; break }
      const slice = found.slice(start, start + AT_ONCE)
      const stats = await Promise.all(slice.map(async ({ path }) => {
        try {
          const stat = await fs.lstat(join(root, path))
          return [path, `${stat.size}:${Math.round(stat.mtimeMs)}`] as const
        } catch { return undefined }
      }))
      for (const entry of stats) {
        if (!entry) continue
        // A file the cap leaves out makes the listing incomplete: it is unknown, not unchanged.
        if (files.size < maxFiles) files.set(entry[0], entry[1])
        else complete = false
      }
    }
    if (!complete) break
  }
  return { files, complete }
}

export interface FileChange {
  path: string
  change: 'edited' | 'created' | 'deleted'
}

/**
 * What differs between two listings, sorted by path. When either listing is incomplete, only a file that both saw can be
 * judged: a file one of them lacks may simply not have been reached.
 */
export function changesBetween(before: Manifest, after: Manifest): FileChange[] {
  const changes: FileChange[] = []
  const trustworthy = before.complete && after.complete
  for (const [path, stamp] of after.files) {
    const was = before.files.get(path)
    if (was === undefined) { if (trustworthy) changes.push({ path, change: 'created' }) } else if (was !== stamp) changes.push({ path, change: 'edited' })
  }
  if (trustworthy) for (const path of before.files.keys()) if (!after.files.has(path)) changes.push({ path, change: 'deleted' })
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
