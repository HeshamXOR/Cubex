import type { DirEntry } from '../../../../shared/ipc'
import { countLines, detectLineEnding, fileNameOf, type ReadFileOptions, type WorkspaceBrowseOptions, type WorkspaceFileResult, type WorkspaceListing, type WorkspacePathStat } from '../../../../shared/workspaceFile'
import { eventsText, heroPng, routesSource } from './filesData/generated'
import { TEXT_FILES } from './filesData/sources'
import type { PreviewSeed } from './index'

/**
 * A sample project for the Files tab (`?seed=1&done=1&review=1&tab=files&files=1`): source with a long JSDoc block,
 * a markdown readme, an SVG, a drawn PNG, a binary font, a CRLF script, a 3,000 line generated file, a 50,000 line log
 * that opens cut at 512 KB, a file that cannot be read, and hidden and ignored entries. Extra flags: `files=slow`
 * makes every read take a second and a half, `files=fail` makes every read fail, and `file=src/upload/client.ts:12`
 * opens that file at that line once the page is up.
 */

const OTHER_FILES = ['assets/fonts/Inter.woff2', 'assets/hero.png', 'data/events.ndjson', 'src/generated/routes.ts', 'src/upload/legacy.ts', 'node_modules/react/package.json', 'node_modules/react/index.js', 'node_modules/vite/package.json']

/** Built on first use: a computation at the top of the module would keep the whole sample project in the packaged app. */
let built: { all: string[]; dirs: Set<string> } | undefined
function project(): { all: string[]; dirs: Set<string> } {
  if (!built) {
    const all = [...Object.keys(TEXT_FILES), ...OTHER_FILES].sort()
    const dirs = new Set(all.flatMap((path) => {
      const parts = path.split('/')
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    }))
    built = { all, dirs }
  }
  return built
}

const isHidden = (path: string): boolean => path.split('/').some((part) => part.startsWith('.') || part === 'node_modules')
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function listing(dir: string, showHidden: boolean): WorkspaceListing {
  const base = normalize(dir === '.' ? '' : dir)
  const prefix = base ? `${base}/` : ''
  const seen = new Map<string, DirEntry>()
  for (const path of project().all) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const name = rest.split('/')[0]!
    const isDirectory = rest.includes('/')
    const hidden = name.startsWith('.') || name === 'node_modules'
    if (hidden && !showHidden) continue
    seen.set(name, { name, path: prefix + name, isDirectory, ...(hidden ? { hidden: true } : {}) })
  }
  if (!seen.size && base && !project().dirs.has(base)) throw new Error(`${base} was not found in the workspace. It may have been moved or deleted.`)
  const entries = [...seen.values()].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  return { entries, omitted: 0 }
}

function find(query: string, limit: number, showHidden: boolean): DirEntry[] {
  const q = query.toLowerCase()
  return project().all
    .filter((path) => !path.startsWith('node_modules/') && (showHidden || !isHidden(path)) && (!q || path.toLowerCase().includes(q)))
    .map((path): DirEntry => ({ name: fileNameOf(path), path, isDirectory: false, ...(isHidden(path) ? { hidden: true } : {}) }))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
}

function stat(path: string): WorkspacePathStat {
  const clean = normalize(path)
  if (project().all.includes(clean)) return { kind: 'file', path: clean }
  if (project().dirs.has(clean)) return { kind: 'directory', path: clean }
  return { kind: 'missing' }
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

async function read(path: string, options: ReadFileOptions | undefined, mode: string | null): Promise<WorkspaceFileResult> {
  await wait(mode === 'slow' ? 1500 : 40)
  const clean = normalize(path)
  const name = fileNameOf(clean)
  const base = { path: clean, name, modifiedAt: Date.now() - 3_600_000 }
  if (mode === 'fail' || clean === 'src/upload/legacy.ts') throw new Error(`Cubex is not allowed to read ${clean}.`)
  if (!project().all.includes(clean)) throw new Error(`${clean} was not found in the workspace. It may have been moved or deleted.`)
  if (clean === 'assets/fonts/Inter.woff2') return { ...base, kind: 'binary', size: 110_592 }
  if (clean === 'assets/hero.png') {
    const dataUrl = heroPng()
    return { ...base, kind: 'image', mime: 'image/png', dataUrl, size: Math.round(dataUrl.length * 0.75) }
  }
  const maxBytes = options?.maxBytes ?? 512 * 1024
  if (clean === 'data/events.ndjson') {
    const { content, totalBytes, truncated } = eventsText(maxBytes)
    return { ...base, kind: 'text', size: totalBytes, content, truncated, lineCount: countLines(content), lineEnding: 'lf', encoding: 'utf-8', bom: false }
  }
  const content = clean === 'src/generated/routes.ts' ? routesSource() : TEXT_FILES[clean] ?? ''
  return { ...base, kind: 'text', size: bytesOf(content), content, truncated: false, lineCount: countLines(content), lineEnding: detectLineEnding(content), encoding: 'utf-8', bom: false }
}

export const seed: PreviewSeed = {
  api: (flags) => {
    const mode = flags.get('files')
    if (mode === null) return {}
    return {
      readWorkspaceDir: async (relPath) => listing(relPath, false).entries,
      listWorkspaceDir: async (relPath, _id, options?: WorkspaceBrowseOptions) => {
        await wait(25)
        return listing(relPath, options?.showHidden === true)
      },
      findWorkspaceFiles: async (query, limit = 50, _id, options?: WorkspaceBrowseOptions) => {
        await wait(25)
        return find(query, limit, options?.showHidden === true)
      },
      searchWorkspaceFiles: async (query, limit = 50) => find(query, limit, false),
      statWorkspacePaths: async (paths) => paths.map(stat),
      readWorkspaceFile: (path, _id, options) => read(path, options, mode),
      revealPath: async () => undefined
    }
  },

  state: (flags) => {
    if (flags.get('files') === null) return undefined
    const target = flags.get('file')
    // The Files tab keeps its own store, so the preview reaches it through a lazy import and a window handle.
    void import('../../state/files').then((files) => {
      ;(window as unknown as { __files: typeof files }).__files = files
      if (!target) return
      const at = /^(.*?)(?::(\d+))?$/.exec(target)
      if (at?.[1]) files.openFile(at[1], at[2] ? Number(at[2]) : undefined)
    })
    return undefined
  }
}
