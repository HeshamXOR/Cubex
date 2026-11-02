import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The commands that check a project's work: what its files say (package.json scripts, a Makefile, Cargo.toml and so on)
 * and the ones that have passed in it before. The system prompt lists them so the model does not guess at `npm test`
 * in a Python project, and the end-of-turn check uses them to name what to run.
 */

export type CheckKind = 'typecheck' | 'test' | 'lint' | 'build'

export interface CheckCommand {
  command: string
  kind: CheckKind
}

const KIND_ORDER: readonly CheckKind[] = ['typecheck', 'test', 'lint', 'build']
/** Most detected commands handed back, and most remembered per project. */
const MAX_DETECTED = 8
export const MAX_REMEMBERED = 6
const MAX_PROJECTS = 200
const MAX_COMMAND_CHARS = 200
const MAX_FILE_BYTES = 256 * 1024

function read(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text
  } catch { return undefined }
}

function rootNames(workspace: string): string[] {
  try { return readdirSync(workspace) } catch { return [] }
}

// --- detection ------------------------------------------------------------------------------------------------

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function packageManager(names: ReadonlySet<string>): PackageManager {
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('yarn.lock')) return 'yarn'
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun'
  return 'npm'
}

/** The script that does each job, first name found wins. */
const SCRIPT_NAMES: Record<CheckKind, readonly string[]> = {
  typecheck: ['typecheck', 'type-check', 'check-types', 'tsc', 'check'],
  test: ['test', 'tests', 'test:unit'],
  lint: ['lint'],
  build: ['build']
}

function scriptCommand(pm: PackageManager, script: string): string {
  // `bun test` is Bun's own runner, not the package's script, so Bun always goes through `run`.
  if (script === 'test' && pm !== 'bun') return `${pm} test`
  return `${pm} run ${script}`
}

function fromPackageJson(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  const text = read(join(workspace, 'package.json'))
  if (!text) return []
  let scripts: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown }
    if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>
  } catch { return [] }
  if (!scripts) return []
  const pm = packageManager(names)
  const found: CheckCommand[] = []
  for (const kind of KIND_ORDER) {
    const script = SCRIPT_NAMES[kind].find((name) => typeof scripts![name] === 'string' && (scripts![name] as string).trim())
    // npm's stock placeholder is not a test.
    if (!script || /no test specified/i.test(String(scripts[script]))) continue
    found.push({ command: scriptCommand(pm, script), kind })
  }
  return found
}

function fromPython(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  const pyproject = read(join(workspace, 'pyproject.toml')) ?? ''
  const setupCfg = read(join(workspace, 'setup.cfg')) ?? ''
  const tox = read(join(workspace, 'tox.ini')) ?? ''
  if (!pyproject && !setupCfg && !names.has('pytest.ini') && !tox) return []
  const runner = names.has('uv.lock') ? 'uv run ' : names.has('poetry.lock') ? 'poetry run ' : ''
  const found: CheckCommand[] = []
  if (names.has('mypy.ini') || /\[tool\.mypy\]/.test(pyproject) || /\[mypy\]/.test(setupCfg)) found.push({ command: `${runner}mypy .`, kind: 'typecheck' })
  if (names.has('pytest.ini') || /\[tool\.pytest/.test(pyproject) || /\[tool:pytest\]/.test(setupCfg) || /\[pytest\]/.test(tox) || /\bpytest\b/.test(pyproject)) {
    found.push({ command: `${runner}pytest`, kind: 'test' })
  }
  if (names.has('ruff.toml') || names.has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)) found.push({ command: `${runner}ruff check .`, kind: 'lint' })
  return found
}

function fromCargo(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  if (!names.has('Cargo.toml')) return []
  return [{ command: 'cargo check', kind: 'typecheck' }, { command: 'cargo test', kind: 'test' }, { command: 'cargo build', kind: 'build' }]
}

function fromGo(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  if (!names.has('go.mod')) return []
  return [{ command: 'go build ./...', kind: 'typecheck' }, { command: 'go test ./...', kind: 'test' }, { command: 'go vet ./...', kind: 'lint' }]
}

function fromMakefile(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  const file = ['Makefile', 'makefile', 'GNUmakefile'].find((name) => names.has(name))
  const text = file ? read(join(workspace, file)) : undefined
  if (!text) return []
  const targets = new Set<string>()
  for (const match of text.matchAll(/^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/gm)) targets.add(match[1]!)
  const pick = (kind: CheckKind, candidates: string[]): CheckCommand[] => {
    const target = candidates.find((name) => targets.has(name))
    return target ? [{ command: `make ${target}`, kind }] : []
  }
  return [...pick('typecheck', ['typecheck']), ...pick('test', ['test', 'check', 'ci']), ...pick('lint', ['lint']), ...pick('build', ['build'])]
}

function fromDotnet(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  if (![...names].some((name) => /\.(?:sln|csproj|fsproj|vbproj)$/i.test(name))) return []
  return [{ command: 'dotnet build', kind: 'typecheck' }, { command: 'dotnet test', kind: 'test' }]
}

function fromJvm(workspace: string, names: ReadonlySet<string>): CheckCommand[] {
  if (names.has('build.gradle') || names.has('build.gradle.kts')) {
    const gradle = names.has('gradlew') || names.has('gradlew.bat') ? './gradlew' : 'gradle'
    return [{ command: `${gradle} test`, kind: 'test' }, { command: `${gradle} build`, kind: 'build' }]
  }
  if (names.has('pom.xml')) {
    const mvn = names.has('mvnw') || names.has('mvnw.cmd') ? './mvnw' : 'mvn'
    return [{ command: `${mvn} compile`, kind: 'typecheck' }, { command: `${mvn} test`, kind: 'test' }]
  }
  return []
}

/**
 * The check commands the project's own files point at, best first: type check, tests, lint, build. A project that
 * mixes several ecosystems gets all of them. Never throws; a folder with nothing recognizable gives an empty list.
 */
export function detectCheckCommands(workspace: string | undefined): CheckCommand[] {
  if (!workspace) return []
  const names = new Set(rootNames(workspace))
  if (names.size === 0) return []
  const all = [fromPackageJson, fromPython, fromCargo, fromGo, fromMakefile, fromDotnet, fromJvm].flatMap((detect) => detect(workspace, names))
  const seen = new Set<string>()
  const unique = all.filter((entry) => !seen.has(entry.command) && !!seen.add(entry.command))
  return unique.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).slice(0, MAX_DETECTED)
}

// --- recognising a check ----------------------------------------------------------------------------------------

const norm = (command: string): string => command.trim().replace(/\s+/g, ' ')

/** A script name that checks something: `test`, `typecheck:node`, `lint`, `build:web`. */
const CHECK_SCRIPT = /(?:^|[:._-])(?:test|tests|typecheck|type-check|check|checks|lint|build|verify|validate|ci|tsc|compile)(?:$|[:._-])/i

/** Options of the package managers that take a value, so the value is not mistaken for the script. */
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--workspaces', '--cache', '--registry'])

/** The script a package manager command runs, and whether it was named with `run` (so `npm ci` is not a script called ci). */
function packageScript(tokens: readonly string[]): { script: string; viaRun: boolean } | undefined {
  let index = 1
  while (index < tokens.length && tokens[index]!.startsWith('-')) index += PM_VALUE_FLAGS.has(tokens[index]!) && !tokens[index]!.includes('=') ? 2 : 1
  let word = tokens[index]
  let viaRun = false
  if (word === 'run' || word === 'run-script') {
    viaRun = true
    index++
    while (index < tokens.length && tokens[index]!.startsWith('-')) index++
    word = tokens[index]
  }
  return word && !word.startsWith('-') ? { script: word, viaRun } : undefined
}

/** Programs whose plain run is a check. */
const CHECK_PROGRAMS = new Set([
  'tsc', 'vue-tsc', 'vitest', 'jest', 'mocha', 'ava', 'eslint', 'biome', 'oxlint', 'stylelint', 'svelte-check',
  'pytest', 'py.test', 'tox', 'nox', 'mypy', 'pyright', 'ruff', 'flake8', 'pylint', 'rspec', 'phpunit', 'phpstan', 'rubocop', 'ctest'
])
/** Runners that start another program: `npx vitest`, `uv run pytest`, `python -m pytest`. */
const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'uv', 'poetry', 'pipenv', 'hatch', 'rye', 'bundle', 'dotenv', 'time', 'env'])
const SUBCOMMAND_CHECKS: Record<string, readonly string[]> = {
  cargo: ['test', 'check', 'build', 'clippy', 'nextest', 'doc'],
  go: ['test', 'build', 'vet'],
  dotnet: ['build', 'test'],
  deno: ['test', 'check', 'lint'],
  swift: ['build', 'test'],
  make: ['test', 'check', 'lint', 'build', 'ci', 'typecheck', 'verify', 'all'],
  mvn: ['test', 'verify', 'compile', 'package'],
  gradle: ['test', 'check', 'build', 'assemble'],
  composer: ['test', 'lint', 'check'],
  zig: ['build', 'test']
}

function segmentIsCheck(segment: string): boolean {
  // Leading VAR=value assignments do not change what runs.
  let tokens = norm(segment).split(' ').filter((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  if (tokens.length === 0) return false
  // `time`, `npx`, `uv run`, `python -m` put a program behind them.
  for (let hops = 0; hops < 3 && tokens.length > 1; hops++) {
    const head = tokens[0]!.toLowerCase().replace(/\.(?:cmd|exe)$/, '')
    if (head === 'pnpm' && tokens[1] === 'exec') tokens = tokens.slice(2)
    else if (head === 'yarn' && (tokens[1] === 'dlx' || tokens[1] === 'exec')) tokens = tokens.slice(2)
    else if (/^python[\d.]*$|^py$/.test(head) && tokens[1] === '-m') tokens = tokens.slice(2)
    else if (head === 'bun' && tokens[1] === 'x') tokens = tokens.slice(2)
    else if (LAUNCHERS.has(head)) {
      let rest = tokens.slice(1)
      if (rest[0] === 'run' || rest[0] === 'exec') rest = rest.slice(1)
      while (rest[0]?.startsWith('-')) rest = rest.slice(1)
      if (rest.length === 0) return false
      tokens = rest
    } else break
  }
  const first = tokens[0]!.replace(/^\.[\\/]/, '').toLowerCase().replace(/\.(?:cmd|exe|bat)$/, '')
  if (first === 'tsc') return !tokens.includes('--init')
  if (CHECK_PROGRAMS.has(first)) return true
  if (first === 'unittest') return true
  // `node --test`, or a test file run directly: `node tests/a.test.js`, `python test_parse.py`.
  if (/^(?:node|tsx|ts-node|python[\d.]*|py)$/.test(first)) {
    if (first === 'node' && tokens.includes('--test')) return true
    const file = tokens.slice(1).find((token) => !token.startsWith('-'))
    return file !== undefined && TEST_FILE.test(file)
  }
  if (first === 'gradlew' || first === 'mvnw') return SUBCOMMAND_CHECKS[first === 'gradlew' ? 'gradle' : 'mvn']!.some((word) => tokens.includes(word))
  if (first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') {
    const named = packageScript(tokens)
    if (!named) return false
    const { script, viaRun } = named
    if (script === 'test' || script === 'tsc') return true
    // `npm ci` and `bun ci` install; npm has no `npm lint`, so only the other managers take a bare script name.
    return CHECK_SCRIPT.test(script) && (viaRun || (first !== 'npm' && script !== 'ci'))
  }
  const subcommands = SUBCOMMAND_CHECKS[first]
  if (subcommands) {
    // `make` with no target runs the default one, which is a build.
    if (first === 'make' && tokens.slice(1).every((token) => token.startsWith('-'))) return true
    return tokens.slice(1).some((token) => subcommands.includes(token))
  }
  return false
}

/** The `--`-separated segments of one command line that run in order and stop at the first failure. */
function segments(command: string): string[] {
  return command.split(/&&|;|\r?\n/).map((part) => part.trim()).filter(Boolean)
}

/**
 * Whether a command line is a check (tests, type check, lint, build) whose exit code tells the model something.
 * `known` are commands this project is known to use. A command whose exit status is not the check's own (a pipe, `|| true`)
 * is not one: it would say passed when the tests failed.
 */
export function isCheckCommand(command: string, known: readonly string[] = []): boolean {
  const text = norm(command)
  if (!text || /(?<!\|)\|(?!\|)/.test(text) || /\|\|\s*(?:true|:|exit\s+0)\b/.test(text)) return false
  const wanted = known.map(norm)
  return segments(text).some((segment) => {
    const clean = segment.replace(/\s+[12]?>>?\s*\S+$/, '').replace(/\s+2>&1$/, '')
    return wanted.some((entry) => clean === entry || clean.startsWith(`${entry} `)) || segmentIsCheck(clean)
  })
}

/** The project's own spelling of a check when the command is that with arguments (`npm test -- src/a.test.ts` is `npm test`). */
export function canonicalCheck(command: string, detected: readonly CheckCommand[]): string {
  const text = norm(command)
  const match = detected.map((entry) => norm(entry.command)).find((entry) => text === entry || text.startsWith(`${entry} `))
  return match ?? text
}

const TEST_FILE = /(?:^|[\\/])(?:test_[\w.-]*\.py|[\w.-]*_test\.py|[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i

/** Source files of languages that have a test runner, so a project without a known check can still be asked to run one. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|cs|fs|rb|php|swift|c|cc|cpp|cxx|h|hpp|zig|dart|ex|exs|lua)$/i

/** Files whose edits a check cannot tell anything about. */
const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|log|csv)$/i

/** Whether an edit to this path is one a check could be run for: not documentation or plain text. */
export function needsCheck(path: string): boolean {
  return !PROSE_FILE.test(path.trim())
}

/**
 * Whether edits to these files are worth asking the agent to check: always when the project has a known check, and
 * otherwise only for source code, so a page of HTML and CSS in a folder with no tests is not held up for one.
 */
export function worthChecking(paths: Iterable<string>, knownChecks: readonly string[]): boolean {
  if (knownChecks.length > 0) return true
  for (const path of paths) if (SOURCE_FILE.test(path.trim())) return true
  return false
}

// --- remembered commands ----------------------------------------------------------------------------------------

/** The key of a project in the store: the same folder spelled two ways is one project. */
export function projectKey(workspace: string, platform: string = process.platform): string {
  const path = resolve(workspace).replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? path.toLowerCase() : path
}

/** What is worth remembering from a passing check: one line, short, nothing that looks like it carries a secret. */
function rememberable(command: string): string | undefined {
  const text = norm(command)
  if (!text || text.length > MAX_COMMAND_CHARS || /[\r\n\0]/.test(command)) return undefined
  if (/\b[A-Za-z_]*(?:key|token|secret|passw(?:or)?d|auth)[A-Za-z_]*=/i.test(text)) return undefined
  return text
}

interface StoredProjects {
  version: 1
  projects: Record<string, { commands: string[]; updatedAt: number }>
}

export interface ProjectCommandStoreOptions {
  /** How long a change waits for more before it is written. Default 750 ms. */
  debounceMs?: number
  onError?: (error: unknown) => void
}

/**
 * The checks that have passed in each project, most recent first, in dataDir()/project-commands.json. A failing run is
 * never recorded and nothing is ever removed because it failed: a command that passed once is still the project's.
 * Writes are debounced and atomic (temp file, then rename); `flush` writes now.
 */
export class ProjectCommandStore {
  private data: StoredProjects | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  constructor(private readonly file: string, private readonly options: ProjectCommandStoreOptions = {}) {}

  private load(): StoredProjects {
    if (this.data) return this.data
    const loaded: StoredProjects = { version: 1, projects: {} }
    if (!existsSync(this.file)) return (this.data = loaded)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredProjects> | null
      if (!parsed || typeof parsed !== 'object' || !parsed.projects || typeof parsed.projects !== 'object') throw new Error('Unrecognized project commands file.')
      for (const [key, entry] of Object.entries(parsed.projects)) {
        const commands = Array.isArray(entry?.commands) ? entry.commands.filter((item): item is string => typeof item === 'string').slice(0, MAX_REMEMBERED) : []
        if (commands.length) loaded.projects[key] = { commands, updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0 }
      }
    } catch (error) {
      // Keep the damaged file for recovery; the next save must not silently drop what it held.
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      this.options.onError?.(error)
    }
    return (this.data = loaded)
  }

  /** The commands that passed in this project, most recent first. */
  list(workspace: string | undefined): string[] {
    if (!workspace) return []
    return [...(this.load().projects[projectKey(workspace)]?.commands ?? [])]
  }

  /** Note a check that exited 0. It moves to the front; the oldest beyond six drop out. */
  remember(workspace: string | undefined, command: string): void {
    const text = rememberable(command)
    if (!workspace || !text) return
    const data = this.load()
    const key = projectKey(workspace)
    const current = data.projects[key]?.commands ?? []
    const next = [text, ...current.filter((entry) => entry !== text)].slice(0, MAX_REMEMBERED)
    // Same order and same front: a repeat of the last passing check writes nothing.
    if (current.length === next.length && current.every((entry, index) => entry === next[index])) return
    data.projects[key] = { commands: next, updatedAt: Date.now() }
    const keys = Object.keys(data.projects)
    if (keys.length > MAX_PROJECTS) {
      keys.sort((a, b) => data.projects[a]!.updatedAt - data.projects[b]!.updatedAt)
      for (const old of keys.slice(0, keys.length - MAX_PROJECTS)) delete data.projects[old]
    }
    this.dirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.options.debounceMs ?? 750)
    // A pending write must not keep the app (or a test run) alive.
    this.timer.unref?.()
  }

  /** Write any pending change now. Never throws. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty || !this.data) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(this.data, null, 2))
      renameSync(temp, this.file)
    } catch (error) {
      this.dirty = true
      this.options.onError?.(error)
    }
  }
}

// --- the prompt section -----------------------------------------------------------------------------------------

/**
 * The body of the "Project commands" section: the commands that have passed here, then the ones the project's files
 * point at. Undefined when there is nothing to say.
 */
export function renderProjectCommands(remembered: readonly string[], detected: readonly CheckCommand[]): string | undefined {
  const known = new Set(remembered.map(norm))
  const rest = detected.filter((entry) => !known.has(norm(entry.command)))
  if (remembered.length === 0 && rest.length === 0) return undefined
  const lines: string[] = []
  if (remembered.length > 0) lines.push('These commands have passed in this project before:', ...remembered.map((command) => `- ${command}`))
  if (rest.length > 0) lines.push(remembered.length > 0 ? 'Also found in the project files:' : 'Found in the project files, not run here yet:', ...rest.map((entry) => `- ${entry.command} (${entry.kind})`))
  return lines.join('\n')
}

/** The best commands to name for a check now: what passed here, then what the project defines. */
export function suggestChecks(remembered: readonly string[], detected: readonly CheckCommand[], limit = 2): string[] {
  const out: string[] = []
  for (const command of [...remembered, ...detected.map((entry) => entry.command)]) {
    if (!out.some((entry) => norm(entry) === norm(command))) out.push(command)
    if (out.length >= limit) break
  }
  return out
}
