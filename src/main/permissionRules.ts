import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { ToolCall } from '@core/types'
import type { PermissionDecision, PermissionMode, PermissionRule } from '@shared/ipc'
import { argumentsStayInWorkspace, isReadOnlyShellCommand, repositoryConfigIsInert, shadowedByWorkspace } from './tools/shellReadOnly'
import { fetchHost } from './tools/webFetchTool'

/**
 * "Always allow" rules: project-scoped pre-approvals for a class of tool call.
 *
 * Rules are only ever created from a suggestion this module computed for a real
 * permission ask (the renderer can resolve an ask with `always`, never author a
 * rule), and they are re-derived from the live call on every match: a command
 * matches only when its own suggested pattern equals the rule's pattern. A stale
 * or hand-edited rule for `rm` or `bash -c` therefore can never approve anything.
 */

/** What "Always allow" would save for a call (the `rule` field of a permission ask). */
export type RuleSuggestion = Pick<PermissionRule, 'tool' | 'pattern' | 'label'>

type RuleCall = Pick<ToolCall, 'name' | 'input'>

/** Seams for tests: the host platform and the (git-spawning) repository config scan. */
export interface RuleEnvironment {
  platform?: NodeJS.Platform
  repositoryIsInert?: (workspace: string) => boolean
}

export interface SuggestContext extends RuleEnvironment {
  /** The turn's absolute workspace root; without one there is no project to scope a rule to. */
  workspace: string | undefined
  mode: PermissionMode
  /** Reasons this call needs a human every time (protected path, text-parsed call...). Any one means no rule. */
  risks: readonly string[]
}

// --- Scope ------------------------------------------------------------------

/** Comparable form of a workspace root: absolute, normalized, and case-folded on Windows. */
export function workspaceKey(workspace: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (typeof workspace !== 'string' || !workspace || !isAbsolute(workspace)) return undefined
  const resolved = resolve(workspace)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function folderName(workspace: string): string {
  const root = resolve(workspace)
  return (basename(root) || root).slice(0, 60)
}

// --- Commands ---------------------------------------------------------------

const MAX_COMMAND_LENGTH = 2_000
/** Characters that chain, redirect, expand or escape in sh, cmd.exe and PowerShell (the read-only classifier's set). */
const SHELL_SYNTAX = /[;&|><`$(){}\r\n%^!]/
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** An unquoted wildcard is expanded by the shell, so a file named like a flag could become an argument. */
const WILDCARD = /[*?[\]]/
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Every token must end at whitespace or the end of the line, so `b"u"ild` is not
// read as three words while the shell sees one.
const TOKEN = /[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=[ \t]|$)/y

/**
 * Words of a single simple command, or undefined for anything with shell syntax:
 * operators, redirects, substitution, line breaks, leading assignments, unquoted
 * wildcards, or quoting this platform's shell would split differently.
 */
export function simpleCommandTokens(command: string, platform: NodeJS.Platform = process.platform): string[] | undefined {
  if (typeof command !== 'string') return undefined
  const line = command.trim()
  if (!line || line.length > MAX_COMMAND_LENGTH || SHELL_SYNTAX.test(line) || CONTROL_CHARACTERS.test(line)) return undefined
  // cmd.exe has no single-quote quoting; sh treats a backslash as an escape.
  if (platform === 'win32' ? line.includes("'") : line.includes('\\')) return undefined
  const tokens: string[] = []
  const reader = new RegExp(TOKEN)
  while (reader.lastIndex < line.length) {
    const match = reader.exec(line)
    if (!match) return undefined
    const quoted = match[1] ?? match[2]
    const token = quoted ?? match[3] ?? ''
    if (!token || (quoted === undefined && WILDCARD.test(token))) return undefined
    tokens.push(token)
  }
  return tokens.length ? tokens : undefined
}

/** Interpreters, shells, destructive or networked tools and privilege changes: never generalized, whatever follows. */
const DENIED_PROGRAMS = new Set([
  'node', 'nodejs', 'deno', 'bunx', 'npx', 'pnpx', 'ts-node', 'tsx',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'cmd', 'command', 'powershell', 'pwsh', 'wsl', 'env', 'exec', 'eval', 'xargs', 'start', 'call',
  'perl', 'ruby', 'php', 'lua', 'osascript', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'shred', 'format', 'diskpart', 'dd', 'mkfs',
  'mv', 'move', 'ren', 'rename', 'cp', 'copy', 'xcopy', 'robocopy', 'ln', 'mklink',
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'netcat',
  'sudo', 'su', 'doas', 'runas', 'chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib',
  'kill', 'pkill', 'killall', 'taskkill', 'shutdown', 'reboot', 'reg', 'schtasks', 'sc'
])

/** Programs whose first argument picks the operation; only the listed operations are generalized. */
const OPERATIONS: Record<string, ReadonlySet<string>> = {
  cargo: new Set(['test', 'build', 'check', 'clippy', 'fmt', 'doc', 'bench']),
  go: new Set(['test', 'build', 'vet', 'fmt']),
  dotnet: new Set(['test', 'build']),
  git: new Set(['status', 'diff', 'log', 'show', 'add', 'commit'])
}
/** git operations that never write; they still go through the read-only classifier's flag checks. */
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show'])
/** Test runners, linters and formatters where the program alone names the operation. */
const STANDALONE_TOOLS = new Set(['pytest', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'ruff', 'mypy', 'flake8', 'pylint', 'black'])
const PYTHON_LAUNCHERS = new Set(['python', 'python3', 'py'])
const PYTHON_MODULES = new Set(['pytest', 'unittest', 'mypy', 'ruff', 'black', 'flake8', 'pylint'])
/**
 * Scripts a runner starts by bare name. npm only has `test` and `start`; pnpm and yarn run any script
 * this way, so only conventional dev-loop names qualify. Everything else goes through `run <script>`.
 */
const SCRIPT_SHORTCUT = /^(?:test|t|lint|build|typecheck|type-check|check|format|fmt|dev|start|compile|coverage|e2e|verify|validate)(?:[:-][A-Za-z0-9:_-]+)?$/
const SHORTCUTS: Record<string, (word: string) => boolean> = {
  npm: (word) => word === 'test' || word === 't' || word === 'start',
  bun: (word) => word === 'test', // other bun words are bundler and package-manager builtins
  pnpm: (word) => SCRIPT_SHORTCUT.test(word),
  yarn: (word) => SCRIPT_SHORTCUT.test(word)
}
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/
/** Script names that suggest irreversible or outward-facing work always ask. */
const RISKY_SCRIPT = /(?:^|[:_-])(?:pre|post)?(?:deploy|publish|release|clean|reset|nuke|purge|wipe|destroy|uninstall|push|prune|drop|migrate|seed)(?:$|[:_-])/i
/** Options that change which program, directory or configuration a tool uses; they never ride along on a rule. */
const REDIRECTING_FLAG = /^--?(?:prefix|cwd|dir|directory|userconfig|globalconfig|script-shell|shell|config|exec|toolexec|manifest-path|rootdir|eval|C)(?:=|$)/i

function scriptIsSafe(script: string | undefined): script is string {
  return script !== undefined && SCRIPT_NAME.test(script) && !RISKY_SCRIPT.test(script)
}

/** The leading arguments that name the operation (`test`, `run build`, `-m pytest`), or undefined when not eligible. */
function operationTokens(program: string, args: string[]): string[] | undefined {
  const [first, second] = args
  const shortcut = SHORTCUTS[program]
  if (shortcut) {
    if (first === undefined) return undefined
    if (first === 'run' || (program === 'npm' && first === 'run-script')) return scriptIsSafe(second) ? [first, second] : undefined
    return shortcut(first) && !RISKY_SCRIPT.test(first) ? [first] : undefined
  }
  if (STANDALONE_TOOLS.has(program)) return []
  if (PYTHON_LAUNCHERS.has(program)) return first === '-m' && second !== undefined && PYTHON_MODULES.has(second) ? [first, second] : undefined
  const operations = OPERATIONS[program]
  return operations && first !== undefined && operations.has(first) ? [first] : undefined
}

/**
 * The rule pattern for a command (its program plus the tokens naming the
 * operation: `npm test`, `npm run build`, `cargo test`, `pytest`), or undefined
 * when the command must always be reviewed. The same function backs suggesting
 * and matching, so a rule can only ever approve commands it would have offered.
 */
export function commandPattern(command: string, workspace: string, env: RuleEnvironment = {}): string | undefined {
  const platform = env.platform ?? process.platform
  if (workspaceKey(workspace, platform) === undefined) return undefined
  const tokens = simpleCommandTokens(command, platform)
  if (!tokens || ENV_ASSIGNMENT.test(tokens[0]!)) return undefined
  const program = tokens[0]!.toLowerCase()
  if (DENIED_PROGRAMS.has(program)) return undefined
  const args = tokens.slice(1)
  const operation = operationTokens(program, args)
  if (!operation) return undefined
  // A same-named file in the workspace would run instead of the real program.
  if (shadowedByWorkspace(program, workspace, platform)) return undefined
  const extra = args.slice(operation.length)
  if (extra.some((arg) => REDIRECTING_FLAG.test(arg)) || !argumentsStayInWorkspace(extra, workspace)) return undefined
  if (program === 'git') {
    // git status/add/commit run repository-configured programs (fsmonitor, filters, hooks path)
    // unless the scan finds none; the read-only operations keep the classifier's flag checks.
    if (!(env.repositoryIsInert ?? repositoryConfigIsInert)(workspace)) return undefined
    if (READ_ONLY_GIT.has(operation[0]!) && !isReadOnlyShellCommand(command)) return undefined
  }
  return [program, ...operation].join(' ')
}

// --- Tool calls -------------------------------------------------------------

const EDIT_TOOLS: readonly string[] = ['edit_file', 'write_file']
const MCP_TOOL = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/

interface CallRuleKey {
  /** Tool names a saved rule may carry to cover this call. */
  tools: readonly string[]
  pattern: string
  label: string
}

/** What a rule must say to approve this call; undefined for calls no rule may ever approve. */
function ruleKey(call: RuleCall, workspace: string, env: RuleEnvironment): CallRuleKey | undefined {
  switch (call.name) {
    case 'run_command': {
      const command = (call.input as { command?: unknown } | null)?.command
      const pattern = typeof command === 'string' ? commandPattern(command, workspace, env) : undefined
      return pattern ? { tools: ['run_command'], pattern, label: pattern } : undefined
    }
    case 'edit_file':
    case 'write_file':
      // One rule covers file edits and file creation; deletions are never generalized.
      return { tools: EDIT_TOOLS, pattern: '*', label: `Edits in ${folderName(workspace)}` }
    case 'web_fetch': {
      const host = fetchHost(call.input)
      return host ? { tools: ['web_fetch'], pattern: host, label: host } : undefined
    }
    case 'delegate_to_subagent':
      return { tools: [call.name], pattern: '*', label: 'Subagents' }
    default: {
      const mcp = MCP_TOOL.exec(call.name)
      return mcp ? { tools: [call.name], pattern: '*', label: `${mcp[2]} from ${mcp[1]}` } : undefined
    }
  }
}

/**
 * The rule "Always allow" would save for this call, or undefined when it cannot
 * be generalized safely: no project, a call that carries risks, a command with
 * shell syntax or a dangerous program, or an edit outside default mode (the
 * other modes already approve edits or block them).
 */
export function suggestRule(call: RuleCall, context: SuggestContext): RuleSuggestion | undefined {
  const { workspace } = context
  if (!workspace || context.risks.length > 0 || workspaceKey(workspace, context.platform) === undefined) return undefined
  if (EDIT_TOOLS.includes(call.name) && context.mode !== 'default') return undefined
  const key = ruleKey(call, workspace, context)
  return key ? { tool: call.name, pattern: key.pattern, label: key.label } : undefined
}

function ruleCovers(rule: Pick<PermissionRule, 'tool' | 'pattern'>, key: CallRuleKey): boolean {
  // Exact comparison: script names are case-sensitive, and hosts are already lower-cased.
  return key.tools.includes(rule.tool) && rule.pattern === key.pattern
}

// --- Persistence ------------------------------------------------------------

const MAX_FIELD = 4_096

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isStoredRule(value: unknown): value is PermissionRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  return boundedString(rule.id, 128) && boundedString(rule.workspace, MAX_FIELD) && isAbsolute(rule.workspace as string) &&
    typeof rule.tool === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(rule.tool) && boundedString(rule.pattern, 512) &&
    typeof rule.label === 'string' && rule.label.length <= 256 && typeof rule.createdAt === 'number' && Number.isFinite(rule.createdAt)
}

export interface PermissionRuleStoreOptions extends RuleEnvironment {
  onError?: (error: unknown) => void
}

/**
 * Saved rules in one JSON file under the app data directory. Writes are atomic
 * (temp file + rename), a damaged file is kept aside instead of overwritten, and
 * rules are matched by workspace root so a rule never leaks into another project.
 */
export class PermissionRuleStore {
  private rules: PermissionRule[] | undefined

  constructor(private readonly file: string, private readonly options: PermissionRuleStoreOptions = {}) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private load(): PermissionRule[] {
    if (this.rules) return this.rules
    if (!existsSync(this.file)) return (this.rules = [])
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { rules?: unknown } | null
      if (!parsed || !Array.isArray(parsed.rules)) throw new Error('Unrecognized permission rules file.')
      return (this.rules = parsed.rules.filter(isStoredRule))
    } catch (error) {
      // Keep the damaged file for recovery; the next save must not silently drop every rule.
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      this.options.onError?.(error)
      return (this.rules = [])
    }
  }

  private persist(next: PermissionRule[]): void {
    // Temp + rename: a crash mid-write leaves the previous file intact.
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, rules: next }, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
    this.rules = next
  }

  private sameWorkspace(rule: PermissionRule, key: string): boolean {
    return workspaceKey(rule.workspace, this.platform) === key
  }

  /** Saved rules, oldest first; `workspace` narrows them to one project. */
  list(workspace?: string): PermissionRule[] {
    const rules = this.load()
    if (workspace === undefined) return rules.map((rule) => ({ ...rule }))
    const key = workspaceKey(workspace, this.platform)
    return key === undefined ? [] : rules.filter((rule) => this.sameWorkspace(rule, key)).map((rule) => ({ ...rule }))
  }

  /** Save a suggestion for a project. An identical rule already saved is returned instead of duplicated. */
  add(workspace: string, suggestion: RuleSuggestion): PermissionRule {
    const key = workspaceKey(workspace, this.platform)
    if (key === undefined) throw new Error('A rule needs an absolute workspace folder.')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(suggestion.tool) || !boundedString(suggestion.pattern, 512) || typeof suggestion.label !== 'string') {
      throw new Error('Invalid permission rule.')
    }
    const rules = this.load()
    const existing = rules.find((rule) => this.sameWorkspace(rule, key) && rule.tool === suggestion.tool && rule.pattern === suggestion.pattern)
    if (existing) return { ...existing }
    const rule: PermissionRule = {
      id: `rule_${nanoid(12)}`, workspace: resolve(workspace), tool: suggestion.tool,
      pattern: suggestion.pattern, label: suggestion.label.slice(0, 256), createdAt: Date.now()
    }
    this.persist([...rules, rule])
    return { ...rule }
  }

  /** Delete a rule by id; false when there was none. */
  remove(id: string): boolean {
    const rules = this.load()
    const next = rules.filter((rule) => rule.id !== id)
    if (next.length === rules.length) return false
    this.persist(next)
    return true
  }

  /** The saved rule of this project that approves the call, if any. */
  find(workspace: string, call: RuleCall): PermissionRule | undefined {
    const key = workspaceKey(workspace, this.platform)
    if (key === undefined) return undefined
    const candidates = this.load().filter((rule) => this.sameWorkspace(rule, key))
    if (!candidates.length) return undefined
    const wanted = ruleKey(call, workspace, this.options)
    const match = wanted && candidates.find((rule) => ruleCovers(rule, wanted))
    return match ? { ...match } : undefined
  }
}

// --- IPC input validation ---------------------------------------------------

export function parsePermissionDecision(value: unknown): PermissionDecision {
  if (value === 'allow' || value === 'deny' || value === 'always') return value
  throw new Error('Invalid permission decision.')
}

/** Ids come from the renderer: bounded, non-empty strings only. */
export function parseRuleId(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`Invalid ${what}.`)
  return value
}

export function parseWorkspaceFilter(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_FIELD) throw new Error('Invalid workspace.')
  return value
}
