import { promises as fs, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { GitIgnore } from './gitignore'

const MAX_PATTERN_LENGTH = 512
const MAX_ALTERNATIVES = 32
const MAX_ENTRIES = 20_000
const MAX_DEPTH = 64
const MAX_DURATION_MS = 5_000

/** Match a single path component without a backtracking regular expression. */
function matchComponent(pattern: string, name: string): boolean {
  let p = 0
  let n = 0
  let star = -1
  let retry = 0
  while (n < name.length) {
    if (pattern[p] === '*') {
      star = p++
      retry = n
    } else if (pattern[p] === '?' || pattern[p] === name[n]) {
      p++
      n++
    } else if (star >= 0) {
      p = star + 1
      n = ++retry
    } else {
      return false
    }
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

function matchPath(pattern: string[], components: string[]): boolean {
  let p = 0
  let n = 0
  let star = -1
  let retry = 0
  while (n < components.length) {
    if (pattern[p] === '**') {
      star = p++
      retry = n
    } else if (pattern[p] !== undefined && matchComponent(pattern[p]!, components[n]!)) {
      p++
      n++
    } else if (star >= 0) {
      p = star + 1
      n = ++retry
    } else {
      return false
    }
  }
  while (pattern[p] === '**') p++
  return p === pattern.length
}

/** Small, bounded glob dialect: *, ?, whole-component **, and brace alternatives. */
function compileGlob(pattern: string): (path: string) => boolean {
  if (!pattern.trim() || pattern.length > MAX_PATTERN_LENGTH || pattern.includes('\0')) {
    throw new Error(`pattern must be a non-empty glob of at most ${MAX_PATTERN_LENGTH} characters.`)
  }
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('pattern must be relative and cannot escape the workspace. Use path to choose a folder.')
  }
  if (normalized.startsWith('!') || /[\[\]]/.test(normalized)) {
    throw new Error('Supported glob syntax: *, **, ?, and {a,b}. Negation and character classes are not supported.')
  }

  const alternatives = [normalized]
  for (let i = 0; i < alternatives.length; i++) {
    const value = alternatives[i]!
    const open = value.indexOf('{')
    if (open < 0) {
      if (value.includes('}')) throw new Error('Unmatched brace in glob pattern.')
      continue
    }
    const close = value.indexOf('}', open + 1)
    if (close < 0 || value.slice(open + 1, close).includes('{')) {
      throw new Error('Brace alternatives must be balanced and cannot be nested.')
    }
    const choices = value.slice(open + 1, close).split(',')
    if (choices.length < 2 || choices.some((part) => !part)) {
      throw new Error('Use non-empty brace alternatives, for example *.{ts,tsx}.')
    }
    if (alternatives.length - 1 + choices.length > MAX_ALTERNATIVES) {
      throw new Error(`Glob patterns support at most ${MAX_ALTERNATIVES} expanded alternatives.`)
    }
    alternatives.splice(i, 1, ...choices.map((part) => value.slice(0, open) + part + value.slice(close + 1)))
    i--
  }
  const patterns = alternatives.map((value) => {
    const components = value.split('/')
    if (components.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Glob patterns must contain relative, non-empty path components.')
    }
    // As with common code-search tools, a basename pattern searches at every depth.
    return components.length === 1 ? ['**', ...components] : components
  })
  return (path) => {
    const components = path.split('/')
    return patterns.some((parts) => matchPath(parts, components))
  }
}

/** After `limit` matches, keep scanning this long to report how many more there were. */
const COUNT_BUDGET_MS = 1_000

export interface FileDiscoveryResult {
  paths: string[]
  /** Why scanning stopped early (a budget), or, when not counting, that more files matched than the limit. */
  truncated?: string
  /** With `countOmitted`: matching files found beyond `limit`. */
  omitted?: number
  /** `omitted` is exact: the whole tree was scanned. */
  omittedExact?: boolean
  skippedDirectories: number
  /** An explicitly selected regular file; it bypasses filename-extension filtering. */
  explicitFile?: boolean
}

/** Enumerate files without following symlinks or buffering unbounded directory listings. */
export async function discoverFiles(options: {
  root: string
  start: string
  pattern: string
  limit: number
  skipDirectories: ReadonlySet<string>
  validatePath: (path: string) => string
  signal?: AbortSignal
  allowFile?: boolean
  /** Entries matched by the workspace's .gitignore rules are skipped; the chosen start path itself never is. */
  ignore?: GitIgnore
  /** Keep scanning past `limit`, briefly, to report how many more files matched. */
  countOmitted?: boolean
  /** Extra file-name test applied before a file counts toward `limit` (for example, text files only). */
  accept?: (name: string) => boolean
}): Promise<FileDiscoveryResult> {
  const { root, start, pattern, limit, skipDirectories, validatePath, signal, ignore, accept } = options
  const matches = compileGlob(pattern)
  signal?.throwIfAborted()
  const isExcluded = (name: string): boolean => skipDirectories.has(process.platform === 'win32' ? name.toLowerCase() : name)
  if (relative(root, start).split(sep).some(isExcluded)) {
    throw new Error('The search path is inside an excluded dependency, generated, or VCS directory.')
  }
  // Explicit paths must follow the same symlink policy as recursive discovery.
  // In particular, an alias must not expose an excluded directory through path.
  let ancestor = root
  for (const component of relative(root, start).split(sep).filter(Boolean)) {
    signal?.throwIfAborted()
    ancestor = join(ancestor, component)
    if ((await fs.lstat(ancestor)).isSymbolicLink()) {
      throw new Error('The search path cannot follow a symbolic link. Use the real workspace-relative path.')
    }
  }
  // A workspace itself may be opened through a junction; links within it remain excluded.
  const startStat = start === root ? await fs.stat(start) : await fs.lstat(start)
  signal?.throwIfAborted()
  if (options.allowFile && startStat.isFile()) {
    return { paths: [relative(root, start).split(sep).join('/')], skippedDirectories: 0, explicitFile: true }
  }
  if (!startStat.isDirectory()) {
    throw new Error(options.allowFile ? 'The search path must be a regular file or folder.' : 'The search path must be a folder.')
  }
  const posix = (path: string): string => relative(root, path).split(sep).join('/')
  // The ignore files above the start folder, and its own, govern everything below it.
  if (ignore) await ignore.load(posix(start))
  const paths: string[] = []
  const queue = [{ path: start, depth: 0 }]
  const deadline = Date.now() + MAX_DURATION_MS
  let scanned = 0
  let skippedDirectories = 0
  let truncated: string | undefined
  let omitted = 0
  let countDeadline = 0

  search: for (let index = 0; index < queue.length; index++) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) {
      truncated = 'the 5 second search budget was reached'
      break
    }
    const directory = queue[index]!
    let handle: Awaited<ReturnType<typeof fs.opendir>>
    try {
      // Recheck containment before each descent, including directories changed during traversal.
      const checkedPath = validatePath(relative(root, directory.path))
      if (directory.path !== root && (await fs.lstat(checkedPath)).isSymbolicLink()) {
        skippedDirectories++
        continue
      }
      handle = await fs.opendir(checkedPath)
    } catch (error) {
      if (index === 0) throw error
      skippedDirectories++
      continue
    }
    // Read the whole listing first: the folder's own .gitignore applies to its entries.
    const entries: Dirent[] = []
    let budgetReached = false
    for await (const entry of handle) {
      signal?.throwIfAborted()
      if (++scanned > MAX_ENTRIES || Date.now() >= deadline) {
        truncated = scanned > MAX_ENTRIES ? `the ${MAX_ENTRIES} entry search budget was reached` : 'the 5 second search budget was reached'
        budgetReached = true
        break
      }
      entries.push(entry)
    }
    if (ignore && directory.path !== start) await ignore.load(posix(directory.path), entries.some((entry) => entry.name === '.gitignore'))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory.path, entry.name)
      if (entry.isDirectory()) {
        if (isExcluded(entry.name)) continue
        if (ignore?.ignores(posix(path), true)) continue
        if (directory.depth >= MAX_DEPTH) {
          truncated = `the ${MAX_DEPTH} directory depth limit was reached`
          continue
        }
        queue.push({ path, depth: directory.depth + 1 })
      } else if (entry.isFile() && matches(relative(start, path).split(sep).join('/')) && (!accept || accept(entry.name))) {
        if (ignore?.ignores(posix(path), false)) continue
        if (paths.length < limit) {
          paths.push(posix(path))
          continue
        }
        if (!options.countOmitted) {
          truncated = `more than ${limit} files matched`
          break search
        }
        if (omitted++ === 0) countDeadline = Date.now() + COUNT_BUDGET_MS
        if (Date.now() >= countDeadline) {
          truncated = 'counting the remaining matches was stopped after a short time budget'
          break search
        }
      }
    }
    if (budgetReached) break
  }
  signal?.throwIfAborted()
  return {
    paths: paths.sort(),
    truncated,
    skippedDirectories,
    ...(omitted > 0 ? { omitted, omittedExact: truncated === undefined } : {})
  }
}
