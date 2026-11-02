import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { childEnvironment } from './childEnv'
import { shadowedByWorkspace } from './tools/shellReadOnly'

/**
 * A compact "repo map" for the system prompt: the files that matter most with
 * their top-level declarations, then a collapsed directory tree. It exists so the
 * model spends fewer read/search calls finding its way around. No native
 * dependencies: declarations come from per-language regexes, importance from
 * entry points, how many files import a file by name, depth and recent commits.
 *
 * Use `repoMaps.get(workspace)` from the prompt builder; the text only changes
 * when the file set, a source file or git HEAD changes, so a prompt cache that
 * contains it stays warm between turns.
 */

const DEFAULT_MAX_CHARS = 6_000
const MIN_MAX_CHARS = 600
/** Files kept for the tree, and source files that are statted and analysed. */
const MAX_LISTED_FILES = 20_000
const MAX_SOURCE_FILES = 2_000
const MAX_WALK_DIRS = 4_000
const MAX_WALK_DEPTH = 12
/** One read per source file covers import lines; small files also yield their declarations from it. */
const HEAD_BYTES = 16 * 1024
/** Larger files are re-read up to this size, only when they make the key-file list. */
const SYMBOL_BYTES = 128 * 1024
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_PACKAGE_JSON_BYTES = 256 * 1024
const MAX_SYMBOLS_SCANNED = 60
const MAX_SIGNATURE_CHARS = 110
const MAX_KEY_FILES = 80
const RECENT_COMMITS = 40
const GIT_TIMEOUT_MS = 8_000
const MAX_GIT_OUTPUT = 8 * 1024 * 1024
const IO_CONCURRENCY = 48
/** A cached map is trusted for this long without even listing the files again. */
const FRESH_MS = 3_000
const MAX_CACHED = 16
const TREE_RESERVE = 1_800

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'target', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.gradle', '.idea', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', 'bower_components', 'site-packages', 'Pods', 'vendor', 'vendored', 'third_party', 'thirdparty',
  'generated', '__generated__'
])
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock', 'go.sum', 'poetry.lock',
  'composer.lock', 'gemfile.lock', 'pipfile.lock', 'uv.lock', 'flake.lock'
])
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.avif', '.svg', '.psd', '.tiff',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm', '.flac',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.xz', '.bz2', '.jar', '.war', '.nupkg',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.pyc', '.wasm', '.node', '.bin', '.pdb',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.map', '.snap', '.db', '.sqlite', '.dmg', '.iso', '.log'
])

type Family = 'ts' | 'py' | 'go' | 'rs' | 'jvm' | 'chdr' | 'other'
const FAMILIES: Record<string, { family: Family; language: string }> = {}
for (const [language, family, extensions] of [
  ['TypeScript', 'ts', ['.ts', '.tsx', '.mts', '.cts']],
  ['JavaScript', 'ts', ['.js', '.jsx', '.mjs', '.cjs']],
  ['Python', 'py', ['.py']],
  ['Go', 'go', ['.go']],
  ['Rust', 'rs', ['.rs']],
  ['Java', 'jvm', ['.java']],
  ['Kotlin', 'jvm', ['.kt', '.kts']],
  ['C#', 'jvm', ['.cs']],
  ['Scala', 'jvm', ['.scala']],
  ['C/C++', 'chdr', ['.h', '.hpp', '.hh', '.hxx']],
  ['C/C++', 'other', ['.c', '.cc', '.cpp', '.cxx']],
  ['Ruby', 'other', ['.rb']],
  ['PHP', 'other', ['.php']],
  ['Swift', 'other', ['.swift']],
  ['Vue', 'other', ['.vue']],
  ['Svelte', 'other', ['.svelte']]
] as Array<[string, Family, string[]]>) for (const extension of extensions) FAMILIES[extension] = { family, language }

const ENTRY_STEMS = new Set(['index', 'main', 'app', 'cli', 'server', 'mod', 'lib', '__main__', 'manage', 'program', 'application', 'bootstrap'])
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|testdata)\/|\.(?:test|spec)\.[^/]+$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/i
const CONFIGISH = /(?:^|\/)[^/]*\.config\.[^/]+$|(?:^|\/)(?:setup|conftest)\.[^/]+$/i
const LOW_VALUE_DIR = /(?:^|\/)(?:docs?|examples?|samples?|scripts?|benchmarks?|tools|demo)\//i

export interface RepoMapOptions {
  /** Hard cap on the returned text. Default 6000. */
  maxChars?: number
  signal?: AbortSignal
}

interface FileEntry { path: string; size: number; mtimeMs: number }

interface Listing {
  /** Every listed file (posix, relative to the workspace), source or not; ignored paths already removed. */
  all: string[]
  head: string
  /** Hash of HEAD and the file list: changes when a file is added, removed or committed over. */
  key: string
}

interface Scan extends Listing {
  /** Source files that exist, sorted by path. */
  source: FileEntry[]
  /** Path -> index of the newest recent commit that touched it (0 = latest). */
  recent: Map<string, number>
}

interface FileFacts {
  mtimeMs: number
  size: number
  /** Module names this file imports (last path segment, lowercase). */
  imports: string[]
  /** Final declaration lines; undefined until read in full. */
  symbols?: string[]
  generated: boolean
}

type Memo = Map<string, FileFacts>

const lower = (value: string): string => value.toLowerCase()
const cacheKey = (path: string): string => (process.platform === 'win32' ? lower(path) : path)
const toPosix = (path: string): string => path.replace(/\\/g, '/')

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

// -- file listing -------------------------------------------------------------

/** Reject paths in ignored folders, lockfiles, binaries and minified bundles. */
function keepPath(path: string): boolean {
  const parts = path.split('/')
  const file = parts.pop()!
  if (parts.some((part) => IGNORED_DIRS.has(part))) return false
  const name = lower(file)
  if (LOCKFILES.has(name) || BINARY_EXTENSIONS.has(extname(name))) return false
  return !/\.min\.[a-z]+$|\.generated\.[a-z]+$|\.bundle\.js$|-lock\.[a-z]+$/.test(name)
}

/** Run git directly with the hardened child environment. Never rejects. */
function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...childEnvironment(), GIT_OPTIONAL_LOCKS: '0' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name]
  return new Promise((done) => {
    const failed = { code: null, stdout: '' }
    let child
    try {
      child = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, signal })
    } catch { return done(failed) }
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes >= MAX_GIT_OUTPUT) return
      chunks.push(chunk.subarray(0, MAX_GIT_OUTPUT - bytes))
      bytes += chunk.length
    })
    child.on('error', () => done(failed))
    child.on('close', (code) => done({ code, stdout: Buffer.concat(chunks).toString('utf8') }))
  })
}

async function listWithGit(root: string, signal?: AbortSignal): Promise<{ files: string[]; head: string } | undefined> {
  // A workspace-planted git.exe/git.bat must never run in place of the real one.
  if (shadowedByWorkspace('git', root)) return undefined
  const [listing, head] = await Promise.all([
    runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, signal),
    runGit(['rev-parse', 'HEAD'], root, signal)
  ])
  if (listing.code !== 0) return undefined
  const names = listing.stdout.split('\0')
  names.pop() // empty after the last terminator, or a path cut off by the output cap
  const files = [...new Set(names.map(toPosix))].filter((path) => path && keepPath(path))
  return files.length === 0 ? undefined : { files, head: head.code === 0 ? head.stdout.trim() : '' }
}

/** Path -> index of the newest recent commit that touched it (0 = latest). Empty outside git. */
async function recentFiles(root: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const recent = new Map<string, number>()
  if (shadowedByWorkspace('git', root)) return recent
  // Rename detection makes this several times slower on a busy history.
  const log = await runGit(['-c', 'core.quotepath=false', 'log', '--relative', '--no-renames', `-n${RECENT_COMMITS}`, '--name-only', '--pretty=format:'], root, signal)
  let commit = 0
  let seen = false
  for (const line of log.code === 0 ? log.stdout.split(/\r?\n/) : []) {
    if (!line) {
      if (seen) commit++
      seen = false
      continue
    }
    seen = true
    if (!recent.has(line)) recent.set(line, commit)
  }
  return recent
}

/** Breadth-first walk that skips ignored and hidden folders and symlinks. */
async function walk(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  let level = ['']
  let dirs = 0
  for (let depth = 0; level.length > 0 && depth <= MAX_WALK_DEPTH; depth++) {
    const next: string[] = []
    await pool(level, 16, async (dir) => {
      if (signal?.aborted || dirs++ >= MAX_WALK_DIRS) return
      let entries
      try { entries = await readdir(dir ? resolve(root, dir) : root, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) next.push(path)
        } else if (entry.isFile() && keepPath(path) && files.length < MAX_LISTED_FILES) files.push(path)
      }
    })
    level = next.sort()
  }
  return files
}

const depthOf = (path: string): number => path.split('/').length - 1
const isSourcePath = (path: string): boolean => FAMILIES[lower(extname(path))] !== undefined

/** The cheap part of a scan: which files exist. Shallow files come first so a cap keeps the ones that orient a reader. */
async function listFiles(root: string, signal?: AbortSignal): Promise<Listing> {
  const git = await listWithGit(root, signal)
  const files = git?.files ?? await walk(root, signal)
  const all = files.sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_LISTED_FILES)
  const hash = createHash('sha1')
  hash.update(`${git?.head ?? ''}\n`)
  for (const path of all) hash.update(`${path}\n`)
  return { all, head: git?.head ?? '', key: hash.digest('hex') }
}

const stampOf = (info: { size: number; mtimeMs: number }): string => `${info.size}:${Math.floor(info.mtimeMs)}`

async function statSource(root: string, all: readonly string[], signal?: AbortSignal): Promise<FileEntry[]> {
  // Tests are never listed or counted as importers, so reading them would be wasted I/O.
  const candidates = all.filter((path) => isSourcePath(path) && !TEST_PATH.test(path)).slice(0, MAX_SOURCE_FILES)
  const found: FileEntry[] = []
  await pool(candidates, IO_CONCURRENCY, async (path) => {
    if (signal?.aborted) return
    try {
      const info = await stat(resolve(root, path))
      if (info.isFile() && info.size > 0 && info.size <= MAX_SOURCE_BYTES) found.push({ path, size: info.size, mtimeMs: Math.floor(info.mtimeMs) })
    } catch { /* deleted but still in the index */ }
  })
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function scan(root: string, signal?: AbortSignal, known?: Listing): Promise<Scan> {
  const listing = known ?? await listFiles(root, signal)
  const [source, recent] = await Promise.all([statSource(root, listing.all, signal), recentFiles(root, signal)])
  return { ...listing, source, recent }
}

// -- imports and declarations -------------------------------------------------

/** "./a/b.js" -> "b", "./a/index" -> "a", "@x/y" -> "y". */
function moduleStem(spec: string): string | undefined {
  const parts = spec.replace(/[?#].*$/, '').split('/').filter((part) => part && part !== '.' && part !== '..')
  let last = parts.pop()
  if (!last) return undefined
  last = last.replace(/\.(?:[mc]?[jt]sx?|json|vue|svelte|css|h|hpp|hh)$/i, '')
  if (last === 'index' && parts.length > 0) last = parts.pop()!
  return lower(last)
}

/** The module name a file answers to when another file imports it. */
function fileStem(path: string): string {
  const parts = path.split('/')
  let stem = parts.pop()!.replace(/\.[^.]*$/, '')
  while (/\.(?:d|test|spec)$/.test(stem)) stem = stem.replace(/\.[^.]*$/, '')
  if ((stem === 'index' || stem === 'mod' || stem === '__init__') && parts.length > 0) stem = parts[parts.length - 1]!
  return lower(stem)
}

function importedModules(family: Family, text: string): string[] {
  const names = new Set<string>()
  const add = (spec: string | undefined): void => {
    const stem = spec ? moduleStem(spec) : undefined
    if (stem) names.add(stem)
  }
  const each = (pattern: RegExp, visit: (match: RegExpExecArray) => void): void => {
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) visit(match)
  }
  switch (family) {
    case 'ts': each(/\b(?:from|import|require)\s*\(?\s*['"]([^'"\n]{1,200})['"]/g, (m) => add(m[1])); break
    case 'py':
      each(/^\s*from\s+([\w.]+)\s+import/gm, (m) => add(m[1]!.split('.').filter(Boolean).pop()))
      each(/^\s*import\s+([\w., ]+)/gm, (m) => { for (const part of m[1]!.split(',')) add(part.trim().split(/\s+/)[0]!.split('.').pop()) })
      break
    case 'go': each(/^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"\s*$/gm, (m) => add(m[1])); break
    case 'rs': each(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:mod|use)\s+([\w:]+)/gm, (m) => { for (const part of m[1]!.split('::')) add(part) }); break
    case 'jvm': each(/^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/gm, (m) => add(m[1]!.split('.').pop())); break
    default: each(/^\s*#\s*include\s+"([^"\n]+)"/gm, (m) => add(m[1])); break
  }
  return [...names]
}

interface Declaration { sig: string; exported: boolean }

/** Join following lines while parentheses are open, so wrapped signatures stay whole. */
function logicalLine(lines: string[], start: number): string {
  let text = lines[start]!
  const open = (value: string): number => (value.match(/[([]/g)?.length ?? 0) - (value.match(/[)\]]/g)?.length ?? 0)
  for (let next = start + 1; next < lines.length && next <= start + 5 && open(text) > 0; next++) text += ` ${lines[next]!.trim()}`
  return text
}

function cleanSignature(raw: string): string {
  let sig = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
  sig = sig.replace(/\s*\{\s*(?:\}\s*)?$/, '').replace(/\s*[=:]$/, '').replace(/;$/, '').trim()
  return sig.length > MAX_SIGNATURE_CHARS ? `${sig.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : sig
}

const TS_DECLARATION = /^(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+function\*?|function\*?|class|interface|type|(?:const\s+)?enum|namespace)\s+[A-Za-z_$]/
const TS_VARIABLE = /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*/
const TS_FUNCTION_VALUE = /=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|=\s*(?:async\s+)?function\b/
const TS_DEFAULT_VALUE = /^export\s+default\s+(?!function|class|async|abstract|interface)/

function declarationsTs(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const line = lines[index]!
    if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '/' || line[0] === '*') continue
    const declaration = TS_DECLARATION.exec(line)
    if (declaration) {
      found.push({ sig: cleanSignature(logicalLine(lines, index).replace(/^export\s+(?!default)/, '')), exported: !!declaration[1] })
      continue
    }
    const variable = TS_VARIABLE.exec(line)
    if (variable) {
      const text = logicalLine(lines, index)
      const isFunction = TS_FUNCTION_VALUE.test(text)
      if (!variable[1] && !isFunction) continue // plain top-level state is noise
      // Keep the signature of a function value, only the name and annotation of data.
      const sig = isFunction ? text.replace(/\s*=>.*$/, '').replace(/=\s*(?:async\s+)?function\b\s*/, '= function') : text.replace(/\s=\s.*$/, '')
      found.push({ sig: cleanSignature(sig.replace(/^export\s+/, '')), exported: !!variable[1] })
      continue
    }
    if (TS_DEFAULT_VALUE.test(line)) found.push({ sig: cleanSignature(line), exported: true })
  }
  return found
}

function declarationsPy(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const match = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(lines[index]!)
    if (match) found.push({ sig: cleanSignature(logicalLine(lines, index)), exported: !match[1]!.startsWith('_') || match[1]!.startsWith('__') })
  }
  return found
}

function declarationsGo(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const line = lines[index]!
    const match = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line) ?? /^type\s+([A-Za-z_]\w*)\s+\S/.exec(line)
    if (match) found.push({ sig: cleanSignature(logicalLine(lines, index)), exported: /^[A-Z]/.test(match[1]!) })
  }
  return found
}

const RUST_DECLARATION = /^(pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(?:fn|struct|enum|trait|type|mod|union)\s+[A-Za-z_]/

function declarationsRs(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const line = lines[index]!
    const match = RUST_DECLARATION.exec(line)
    if (match) found.push({ sig: cleanSignature(logicalLine(lines, index).replace(/\s+where\b.*$/, '')), exported: !!match[1] })
    else if (/^impl\b/.test(line)) found.push({ sig: cleanSignature(line.replace(/\s+where\b.*$/, '')), exported: true })
  }
  return found
}

const JVM_TYPE = /^\s{0,8}(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|private|protected|internal|open|abstract|sealed|final|static|partial|data|inner|enum|annotation|value|readonly|unsafe)\s+)*)(?:class|interface|record|object|struct|trait)\s+[A-Za-z_]/
const KOTLIN_FUNCTION = /^((?:(?:public|internal|private|suspend|inline|operator|tailrec)\s+)*)fun\s+/

function declarationsJvm(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const line = lines[index]!
    const match = JVM_TYPE.exec(line) ?? KOTLIN_FUNCTION.exec(line)
    if (match) found.push({ sig: cleanSignature(logicalLine(lines, index).replace(/^\s+/, '')), exported: !/\bprivate\b/.test(match[1] ?? '') })
  }
  return found
}

const C_TYPE = /^(?:template\s*<[^>]*>\s*)?(?:class|struct|enum(?:\s+class)?|namespace)\s+[A-Za-z_]/
const C_PROTOTYPE = /^(?!return\b|typedef\b|using\b|friend\b|else\b|#)[A-Za-z_][\w:<>,*&\s]*?[\s*&]~?[A-Za-z_]\w*\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?;\s*$/

function declarationsHeader(lines: string[]): Declaration[] {
  const found: Declaration[] = []
  for (let index = 0; index < lines.length && found.length < MAX_SYMBOLS_SCANNED; index++) {
    const line = lines[index]!
    if (C_TYPE.test(line) && !/;\s*$/.test(line)) found.push({ sig: cleanSignature(line), exported: true })
    else if (/^[A-Za-z_]/.test(line) && C_PROTOTYPE.test(logicalLine(lines, index))) found.push({ sig: cleanSignature(logicalLine(lines, index)), exported: true })
  }
  return found
}

/** Top-level declarations as one signature line each; exported ones only when the file has any. */
export function extractDeclarations(path: string, text: string): string[] {
  const family = FAMILIES[lower(extname(path))]?.family ?? 'other'
  const lines = text.split(/\r?\n/)
  const found = family === 'ts' ? declarationsTs(lines)
    : family === 'py' ? declarationsPy(lines)
    : family === 'go' ? declarationsGo(lines)
    : family === 'rs' ? declarationsRs(lines)
    : family === 'jvm' ? declarationsJvm(lines)
    : family === 'chdr' ? declarationsHeader(lines)
    : []
  const picked = found.some((declaration) => declaration.exported) ? found.filter((declaration) => declaration.exported) : found
  return [...new Set(picked.map((declaration) => declaration.sig))]
}

/** Very long lines mean a bundle or data blob, not code a reader would navigate. */
const looksGenerated = (text: string): boolean => text.split('\n', 40).some((line) => line.length > 2_000)

async function readPrefix(file: string, bytes: number): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const view = buffer.subarray(0, bytesRead)
    if (view.includes(0)) return undefined // binary
    return view.toString('utf8')
  } catch { return undefined }
  finally { await handle?.close().catch(() => undefined) }
}

async function analyse(root: string, files: FileEntry[], memo: Memo, signal?: AbortSignal): Promise<void> {
  const live = new Set(files.map((file) => file.path))
  for (const path of memo.keys()) if (!live.has(path)) memo.delete(path)
  await pool(files, IO_CONCURRENCY, async (file) => {
    if (signal?.aborted) return
    const known = memo.get(file.path)
    if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) return
    const text = await readPrefix(resolve(root, file.path), Math.min(file.size, HEAD_BYTES))
    const facts: FileFacts = { mtimeMs: file.mtimeMs, size: file.size, imports: [], generated: text === undefined || looksGenerated(text) }
    if (text !== undefined && !facts.generated) {
      const family = FAMILIES[lower(extname(file.path))]?.family ?? 'other'
      facts.imports = importedModules(family, text)
      if (file.size <= HEAD_BYTES) facts.symbols = extractDeclarations(file.path, text)
    }
    memo.set(file.path, facts)
  })
}

// -- ranking ------------------------------------------------------------------

/** Files named by package.json main/module/bin, mapped back to source when they point into build output. */
async function packageEntries(root: string, all: ReadonlySet<string>): Promise<Set<string>> {
  const entries = new Set<string>()
  if (!all.has('package.json')) return entries
  let manifest: { main?: unknown; module?: unknown; bin?: unknown }
  try {
    const raw = await readFile(resolve(root, 'package.json'), 'utf8')
    if (raw.length > MAX_PACKAGE_JSON_BYTES) return entries
    manifest = JSON.parse(raw)
  } catch { return entries }
  const targets: string[] = []
  for (const value of [manifest.main, manifest.module, ...(typeof manifest.bin === 'object' && manifest.bin ? Object.values(manifest.bin) : [manifest.bin])]) {
    if (typeof value === 'string') targets.push(value.replace(/^\.\//, ''))
  }
  for (const target of targets) {
    const stem = target.replace(/\.[^./]+$/, '')
    const candidates = [target, ...['ts', 'tsx', 'js', 'mjs'].map((ext) => `${stem}.${ext}`)]
    const source = stem.replace(/^(?:out|dist|build|lib)\//, 'src/')
    if (source !== stem) candidates.push(...['ts', 'tsx', 'js', 'mjs'].map((ext) => `${source}.${ext}`))
    const hit = candidates.find((candidate) => all.has(candidate))
    if (hit) entries.add(hit)
  }
  return entries
}

async function packageScripts(root: string, all: ReadonlySet<string>): Promise<string | undefined> {
  if (!all.has('package.json')) return undefined
  try {
    const raw = await readFile(resolve(root, 'package.json'), 'utf8')
    if (raw.length > MAX_PACKAGE_JSON_BYTES) return undefined
    const scripts = (JSON.parse(raw) as { scripts?: unknown }).scripts
    if (!scripts || typeof scripts !== 'object') return undefined
    const names = Object.keys(scripts).slice(0, 12)
    return names.length > 0 ? `package.json scripts: ${names.join(', ')}` : undefined
  } catch { return undefined }
}

interface Ranked { path: string; score: number; entry: boolean }

function rank(scanned: Scan, memo: Memo, entries: ReadonlySet<string>): Ranked[] {
  const files = scanned.source.filter((file) => !memo.get(file.path)?.generated)
  const sharers = new Map<string, number>()
  for (const file of files) sharers.set(fileStem(file.path), (sharers.get(fileStem(file.path)) ?? 0) + 1)
  const importers = new Map<string, number>()
  for (const file of files) {
    if (TEST_PATH.test(file.path)) continue
    for (const name of memo.get(file.path)?.imports ?? []) importers.set(name, (importers.get(name) ?? 0) + 1)
  }
  const ranked: Ranked[] = []
  for (const file of files) {
    if (TEST_PATH.test(file.path)) continue
    const stem = fileStem(file.path)
    const bare = lower(basename(file.path).replace(/\.[^.]*$/, ''))
    const entry = entries.has(file.path)
    const inbound = Math.round((importers.get(stem) ?? 0) / (sharers.get(stem) ?? 1))
    const recent = scanned.recent.get(file.path)
    let score = 0
    if (entry) score += 60
    if (ENTRY_STEMS.has(bare)) score += 25
    score += Math.min(inbound, 30) * 4
    score += Math.min(memo.get(file.path)?.symbols?.length ?? 0, 10) / 2
    if (recent !== undefined) score += Math.max(2, 14 - recent)
    score -= depthOf(file.path) * 5
    if (CONFIGISH.test(file.path)) score -= 20
    if (/\.d\.ts$/.test(file.path)) score -= 30
    if (LOW_VALUE_DIR.test(file.path)) score -= 10
    ranked.push({ path: file.path, score: Math.round(score * 10) / 10, entry })
  }
  return ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// -- rendering ----------------------------------------------------------------

interface TreeNode { name: string; count: number; dirs: Map<string, TreeNode> }

function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: '', count: 0, dirs: new Map() }
  for (const path of paths) {
    const parts = path.split('/')
    parts.pop()
    let node = root
    node.count++
    for (const part of parts) {
      let child = node.dirs.get(part)
      if (!child) node.dirs.set(part, child = { name: part, count: 0, dirs: new Map() })
      child.count++
      node = child
    }
  }
  return root
}

const MAX_CHILD_DIRS = 30

function renderTree(root: TreeNode, budget: number): string[] {
  const expanded = new Set<TreeNode>([root])
  const lines = (): string[] => {
    const out: string[] = []
    const visit = (node: TreeNode, indent: string): void => {
      const children = [...node.dirs.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)).slice(0, MAX_CHILD_DIRS)
      for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        out.push(`${indent}${child.name}/ (${child.count})`)
        if (expanded.has(child)) visit(child, `${indent}  `)
      }
      if (node.dirs.size > children.length) out.push(`${indent}… ${node.dirs.size - children.length} more folders`)
    }
    visit(root, '')
    return out
  }
  const size = (list: string[]): number => list.reduce((total, line) => total + line.length + 1, 0)
  let current = lines()
  // Open the biggest collapsed folder that still fits, until nothing more does.
  const tried = new Set<TreeNode>()
  for (let round = 0; round < 80; round++) {
    const open: TreeNode[] = []
    const collect = (node: TreeNode): void => {
      for (const child of node.dirs.values()) {
        if (expanded.has(child)) collect(child)
        else if (child.dirs.size > 0 && child.count >= 6 && !tried.has(child)) open.push(child)
      }
    }
    collect(root)
    if (open.length === 0) break
    const target = open.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))[0]!
    tried.add(target)
    expanded.add(target)
    const trial = lines()
    if (size(trial) <= budget) current = trial
    else expanded.delete(target)
  }
  return size(current) <= budget ? current : []
}

function languageSummary(scanned: Scan): string {
  const counts = new Map<string, number>()
  for (const path of scanned.all) {
    const language = FAMILIES[lower(extname(path))]?.language
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([language, count]) => `${language} ${count}`).join(', ')
}

interface Rendered {
  text: string
  /** Files whose content the text quotes: a change to one of these changes the text. */
  shown: string[]
}

async function render(root: string, scanned: Scan, memo: Memo, maxChars: number, signal?: AbortSignal): Promise<Rendered | undefined> {
  if (scanned.source.length === 0) return undefined
  const all = new Set(scanned.all)
  const [entries, scripts] = await Promise.all([packageEntries(root, all), packageScripts(root, all)])
  const ranked = rank(scanned, memo, entries)

  // Large files only had their first HEAD_BYTES read; read the rest for the ones that may be listed.
  const sizes = new Map(scanned.source.map((file) => [file.path, file.size]))
  const shortlist = ranked.slice(0, MAX_KEY_FILES * 2)
  await pool(shortlist, IO_CONCURRENCY, async (item) => {
    const facts = memo.get(item.path)
    if (!facts || facts.symbols || signal?.aborted) return
    const text = await readPrefix(resolve(root, item.path), Math.min(sizes.get(item.path) ?? 0, SYMBOL_BYTES))
    facts.symbols = text === undefined ? [] : extractDeclarations(item.path, text)
  })
  if (signal?.aborted) return undefined

  const head = [
    'Project map: top-level files and declarations; read files before relying on details.',
    `${basename(root) || root}: ${scanned.all.length} files (${languageSummary(scanned)})`
  ]
  if (scripts) head.push(scripts)
  const rootFiles = scanned.all.filter((path) => !path.includes('/') && !path.startsWith('.')).slice(0, 14)
  const rootLine = rootFiles.length > 0 ? `Root files: ${rootFiles.join(', ')}` : undefined
  if (rootLine) head.push(rootLine.length > 240 ? `${rootLine.slice(0, 239)}…` : rootLine)

  const treeReserve = Math.min(TREE_RESERVE, Math.floor(maxChars * 0.3))
  let used = head.join('\n').length + 1
  const keyLimit = maxChars - treeReserve - 'Key files (most important first):\n'.length - 'Folders (file counts):\n'.length
  const blocks: string[] = []
  const shown = new Set<string>(all.has('package.json') ? ['package.json'] : [])
  for (const [index, item] of ranked.entries()) {
    if (blocks.length >= MAX_KEY_FILES || keyLimit - used < 40) break
    const symbols = memo.get(item.path)?.symbols ?? []
    if (symbols.length === 0 && !item.entry) continue
    // Breadth beats depth: the model can read a file, but it cannot guess that one exists.
    const quota = index < 4 ? 8 : index < 12 ? 5 : 3
    const title = item.entry ? `${item.path} [entry]` : item.path
    // Fewer declarations rather than dropping the file when it does not quite fit.
    for (let take = Math.min(quota, symbols.length); take >= (item.entry ? 0 : 1); take--) {
      const block = [title, ...symbols.slice(0, take).map((sig) => `  ${sig}`)].join('\n')
      if (used + block.length + 1 <= keyLimit) {
        blocks.push(block)
        shown.add(item.path)
        used += block.length + 1
        break
      }
    }
  }

  const out = [...head]
  if (blocks.length > 0) out.push('Key files (most important first):', ...blocks)
  const treeBudget = maxChars - out.join('\n').length - 'Folders (file counts):\n'.length - 2
  const tree = treeBudget > 40 ? renderTree(buildTree(scanned.all), treeBudget) : []
  if (tree.length > 0) out.push('Folders (file counts):', ...tree)
  let text = out.join('\n')
  if (text.length > maxChars) text = text.slice(0, text.lastIndexOf('\n', maxChars))
  return { text, shown: [...shown] }
}

// -- public API ---------------------------------------------------------------

async function canonicalRoot(workspace: string): Promise<string | undefined> {
  try {
    const root = await realpath(resolve(workspace))
    return (await stat(root)).isDirectory() ? root : undefined
  } catch { return undefined }
}

const clampChars = (options?: RepoMapOptions): number => Math.max(MIN_MAX_CHARS, Math.floor(options?.maxChars ?? DEFAULT_MAX_CHARS))

/**
 * Build the map for a folder from scratch. Undefined for a missing or empty folder, a folder without source
 * code, an aborted build, or any failure: a missing map must never break a turn.
 */
export async function buildRepoMap(workspace: string, options?: RepoMapOptions): Promise<string | undefined> {
  try {
    const root = await canonicalRoot(workspace)
    if (!root || options?.signal?.aborted) return undefined
    const scanned = await scan(root, options?.signal)
    const memo: Memo = new Map()
    await analyse(root, scanned.source, memo, options?.signal)
    return (await render(root, scanned, memo, clampChars(options), options?.signal))?.text
  } catch { return undefined }
}

/** Re-stat the files a map quotes; the rest of the project is covered by the file list and HEAD. */
async function stillSame(root: string, watched: ReadonlyMap<string, string>): Promise<boolean> {
  let same = true
  await pool([...watched], IO_CONCURRENCY, async ([path, stamp]) => {
    try {
      const info = await stat(resolve(root, path))
      // package.json is quoted but never analysed, so it has no recorded stamp.
      if (stamp !== '' && stampOf(info) !== stamp) same = false
    } catch { same = false }
  })
  return same
}

interface CacheEntry {
  checkedAt: number
  /** Listing.key of the last build. */
  listKey: string
  /** Size and mtime of every file the text quotes, as they were when it was built. */
  watched: Map<string, string>
  maxChars: number
  text: string | undefined
  memo: Memo
  building?: Promise<string | undefined>
}

/**
 * Per-workspace cache around the builder. A call within FRESH_MS of the last check returns the previous text
 * without touching the disk; after that the file list and mtimes are re-checked (cheap) and the text is
 * rebuilt only when the file set, a source file or git HEAD changed. Per-file facts survive rebuilds, so
 * only changed files are read again. Concurrent callers for one workspace share one build.
 */
export class RepoMapCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(private readonly freshMs = FRESH_MS) {}

  async get(workspace: string | undefined, options?: RepoMapOptions): Promise<string | undefined> {
    if (!workspace) return undefined
    try {
      const root = await canonicalRoot(workspace)
      if (!root || options?.signal?.aborted) return undefined
      const key = cacheKey(root)
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { checkedAt: 0, listKey: '', watched: new Map(), maxChars: 0, text: undefined, memo: new Map() }
        this.entries.set(key, entry)
        if (this.entries.size > MAX_CACHED) this.entries.delete(this.entries.keys().next().value!)
      }
      const maxChars = clampChars(options)
      if (entry.building) return await entry.building
      if (entry.maxChars === maxChars && Date.now() - entry.checkedAt < this.freshMs) return entry.text
      const target = entry
      const building = this.refresh(root, target, maxChars, options?.signal)
      target.building = building
      try { return await building } finally { target.building = undefined }
    } catch { return undefined }
  }

  /** Forget a workspace, or everything. */
  clear(workspace?: string): void {
    if (workspace === undefined) return this.entries.clear()
    const root = resolve(workspace)
    for (const key of [...this.entries.keys()]) if (key === cacheKey(root)) this.entries.delete(key)
  }

  private async refresh(root: string, entry: CacheEntry, maxChars: number, signal?: AbortSignal): Promise<string | undefined> {
    const listing = await listFiles(root, signal)
    if (signal?.aborted) return entry.text
    if (listing.key === entry.listKey && entry.maxChars === maxChars && await stillSame(root, entry.watched)) {
      entry.checkedAt = Date.now()
      return entry.text
    }
    const scanned = await scan(root, signal, listing)
    await analyse(root, scanned.source, entry.memo, signal)
    const rendered = await render(root, scanned, entry.memo, maxChars, signal)
    if (signal?.aborted) return entry.text
    const stamps = new Map(scanned.source.map((file) => [file.path, stampOf(file)]))
    const watched = new Map<string, string>()
    for (const path of rendered?.shown ?? []) watched.set(path, stamps.get(path) ?? '')
    Object.assign(entry, { checkedAt: Date.now(), listKey: listing.key, watched, maxChars, text: rendered?.text })
    return rendered?.text
  }
}

/** Shared instance for the prompt builder. */
export const repoMaps = new RepoMapCache()
