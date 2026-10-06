import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']
/** Folders that hold dependencies or build output; a config in there says nothing about the project. */
const SKIPPED = new Set(['node_modules', 'dist', 'out', 'build', 'release', 'coverage', 'target', 'vendor'])
/** The root, its folders, and theirs: where a repository keeps a project config (a monorepo's packages/*). */
const MAX_DEPTH = 2
const MAX_FOLDERS = 300

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * The config that makes this folder a checkable project: a tsconfig.json or jsconfig.json at the root, or
 * failing that the first one in a folder up to two levels down. Absolute path, or undefined when the folder
 * has none. Bounded, so a huge tree costs at most a few hundred directory reads.
 */
export function findProjectConfig(root: string): string | undefined {
  let level = [root]
  let visited = 0
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      for (const name of CONFIG_NAMES) {
        const candidate = join(dir, name)
        if (isFile(candidate)) return candidate
      }
      if (depth === MAX_DEPTH) continue
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue
        if (++visited > MAX_FOLDERS) return undefined
        next.push(join(dir, entry.name))
      }
    }
    level = next
  }
  return undefined
}
