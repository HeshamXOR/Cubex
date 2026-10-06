import * as fs from 'node:fs'
import { isWithinRoot, pathKey } from './paths'

/** Files above this size are treated as absent: a generated bundle must not bloat the checker's memory. */
export const MAX_READ_BYTES = 8 * 1024 * 1024
const CACHE_LIMIT = 50_000

/**
 * Every file-system question the TypeScript compiler asks goes through here. Only the workspace, the
 * package folders (node_modules of the workspace and of its parents, the places a package manager installs
 * to) and the TypeScript lib folder are readable. Content reads also check the real path, so a junction or
 * symlink inside the workspace cannot lead the checker to a file outside the allowed folders.
 */
export class GuardedFs {
  private readonly roots: string[]
  private readonly allowedCache = new Map<string, boolean>()

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => pathKey(root))
  }

  /** Lexical containment in one of the allowed folders. */
  allowed(path: string): boolean {
    const cached = this.allowedCache.get(path)
    if (cached !== undefined) return cached
    const key = pathKey(path)
    const result = this.roots.some((root) => isWithinRoot(root, key))
    if (this.allowedCache.size >= CACHE_LIMIT) this.allowedCache.clear()
    this.allowedCache.set(path, result)
    return result
  }

  private stat(path: string): fs.Stats | undefined {
    if (!this.allowed(path)) return undefined
    try { return fs.statSync(path, { throwIfNoEntry: false }) } catch { return undefined }
  }

  fileExists(path: string): boolean {
    return this.stat(path)?.isFile() ?? false
  }

  directoryExists(path: string): boolean {
    return this.stat(path)?.isDirectory() ?? false
  }

  getDirectories(path: string): string[] {
    if (!this.allowed(path)) return []
    try {
      return fs.readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && this.directoryExists(`${path}/${entry.name}`)))
        .map((entry) => entry.name)
    } catch { return [] }
  }

  /** The canonical path, or the input when it cannot be resolved. May lie outside the allowed folders; reads then fail. */
  realpath(path: string): string {
    if (!this.allowed(path)) return path
    try { return fs.realpathSync.native(path) } catch { return path }
  }

  /** The file's text, or undefined when it is missing, too large, binary-unsafe or outside the allowed folders. */
  readFile(path: string): string | undefined {
    const stat = this.stat(path)
    if (!stat?.isFile() || stat.size > MAX_READ_BYTES) return undefined
    const real = this.realpath(path)
    if (!this.allowed(real)) return undefined
    try {
      const bytes = fs.readFileSync(real)
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2)
      return bytes.toString('utf8', bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0)
    } catch { return undefined }
  }

  /** Whether readFile would return text for this path, without reading it. */
  isReadable(path: string): boolean {
    const stat = this.stat(path)
    return !!stat?.isFile() && stat.size <= MAX_READ_BYTES && this.allowed(this.realpath(path))
  }

  /** Change stamp of a file on disk: modification time and size; '0' when it does not exist or may not be read. */
  version(path: string): string {
    const stat = this.stat(path)
    return stat?.isFile() ? `${stat.mtimeMs}:${stat.size}` : '0'
  }

  /** Stamp of a folder (its modification time), for detecting installs and removals. */
  folderStamp(path: string): string {
    const stat = this.stat(path)
    return stat ? String(stat.mtimeMs) : '0'
  }
}
