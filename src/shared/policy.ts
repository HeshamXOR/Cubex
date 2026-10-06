import type { HookConfig } from './settings'

/**
 * Shapes and checks shared by the MCP, hooks and permissions settings groups. Pure on purpose:
 * the Settings page validates with the same limits the main process enforces.
 */

type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

// --- MCP servers -------------------------------------------------------------

const MCP_LIMITS = {
  id: 128,
  name: 80,
  command: 1_024,
  arguments: 64,
  argumentChars: 8_192,
  totalArgumentChars: 32_768
} as const

/** What a server's environment may hold. The total keeps the whole block well under what a process can be started with. */
export const MCP_ENV_LIMITS = {
  /** Variables per server, plain and secret together. */
  variables: 32,
  name: 128,
  value: 8_192,
  /** Names and values together. */
  totalChars: 24_576
} as const

const SERVER_ID = /^[A-Za-z0-9_-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Names that usually hold a credential: the ones Cubex keeps out of a child's inherited environment, and their bare forms. */
const SECRET_LOOKING = /(?:^|_)(?:KEY|SECRET|TOKEN|PASS(?:WORD|WD|PHRASE)?|PAT|CREDENTIALS?)$|^DATABASE_URL$|APIKEY|ACCESSKEY/i

/** Why `name` cannot name an environment variable, or undefined when it can. */
export function envNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a name.'
  if (name.length > MCP_ENV_LIMITS.name) return `Use ${MCP_ENV_LIMITS.name} characters or fewer.`
  if (name === '__proto__') return 'This name is reserved.'
  if (!ENV_NAME.test(name)) return 'Use letters, digits and underscores, and do not start with a digit.'
  return undefined
}

/** True for names like API_KEY or GITHUB_TOKEN, which should be kept as secrets. Only a nudge and a redaction hint; any name can be a secret. */
export function looksLikeSecretName(name: string): boolean {
  return SECRET_LOOKING.test(name)
}

/** The names that appear more than once, compared without regard to case (Windows does not tell them apart), in the case they were first written. */
export function duplicateEnvNames(names: readonly string[]): Set<string> {
  const first = new Map<string, string>()
  const repeated = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    const earlier = first.get(key)
    if (earlier === undefined) first.set(key, name)
    else repeated.add(earlier)
  }
  return repeated
}

/**
 * The credential reference a server's secret variable is stored under. One function names it when saving
 * and when reading, and a reference in settings that is not exactly this one is never resolved, so settings
 * cannot be made to hand another credential (a provider's key) to a server.
 */
export function mcpSecretRef(serverId: string, name: string): string {
  return `mcp-env:${serverId}:${name}`
}

function isMcpServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MCP_LIMITS.id && SERVER_ID.test(value)
}

/**
 * The fields of a server that matter for a connection test. Variables ride along on purpose: a server that
 * needs a token cannot be tested without it. Values are used for the test and never echoed back.
 */
export interface McpTestRequest {
  /** Present for a saved server, so the result also shows on its row. Absent for the add form. */
  id?: string
  name: string
  command: string
  args?: string[]
  /** Plain variables, as the form shows them. */
  env?: Record<string, string>
  /** Secrets typed in the form and not saved yet: name to value. Used for this test only and never stored. */
  secrets?: Record<string, string>
  /** Names of secrets already saved for the server `id`. Their values are read from the credential store. */
  savedSecrets?: string[]
}

export interface McpToolSummary {
  name: string
  description?: string
}

interface McpServerIdentity {
  name: string
  version?: string
}

export interface McpTestResult {
  ok: boolean
  durationMs: number
  /** What the server called itself in its initialize reply. */
  server?: McpServerIdentity
  protocolVersion?: string
  /** At most MCP_LIST_LIMIT tools; `toolCount` is the real number. */
  tools: McpToolSummary[]
  toolCount: number
  /** One sentence on what went wrong. */
  error?: string
  /** What to do about it. */
  hint?: string
  /** The server's own stderr, redacted and capped. Present only when it printed something. */
  output?: string
}

/** `idle` means no turn has started the server since Cubex launched. */
type McpServerState = 'disabled' | 'idle' | 'connected' | 'failed'

export interface McpServerStatus {
  id: string
  state: McpServerState
  /** Only for a connected server. */
  tools: McpToolSummary[]
  toolCount: number
  server?: McpServerIdentity
  error?: string
  hint?: string
  output?: string
  /** Secret variables of this server whose saved value can no longer be read; the server is not started until they are entered again. */
  missingSecrets?: string[]
  /** The last connection test of this saved server since Cubex launched. */
  lastTest?: { at: number; ok: boolean; toolCount: number; error?: string }
}

/** Tools and text returned to the page are capped so one chatty server cannot flood the renderer. */
export const MCP_LIST_LIMIT = 200
export const MCP_DESCRIPTION_LIMIT = 600
export const MCP_OUTPUT_LIMIT = 4_000

const CONTROL = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Check the argument list the way the add form does, so both sides agree on what a valid server is. */
function validateMcpArguments(value: unknown): Validated<string[]> {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value) || value.some((argument) => typeof argument !== 'string')) {
    return { ok: false, error: 'Arguments must be a list of strings.' }
  }
  if (value.length > MCP_LIMITS.arguments) return { ok: false, error: `Use ${MCP_LIMITS.arguments} arguments or fewer.` }
  let total = 0
  for (const [index, argument] of (value as string[]).entries()) {
    if (argument.includes('\0')) return { ok: false, error: `Argument ${index + 1} contains a null character, which cannot be passed to a process.` }
    if (argument.length > MCP_LIMITS.argumentChars) return { ok: false, error: `Argument ${index + 1} must be ${MCP_LIMITS.argumentChars.toLocaleString('en-US')} characters or fewer.` }
    total += argument.length
  }
  if (total > MCP_LIMITS.totalArgumentChars) return { ok: false, error: `Arguments must total ${MCP_LIMITS.totalArgumentChars.toLocaleString('en-US')} characters or fewer.` }
  return { ok: true, value: value as string[] }
}

/** A name safe to quote in a message, whatever the page sent. */
function shown(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

/** Pairs of variable name and text value. Messages name the variable and never repeat a value. */
function variableMap(value: unknown, secret: boolean): Validated<Record<string, string>> {
  if (value === undefined) return { ok: true, value: {} }
  if (!isRecord(value)) return { ok: false, error: `${secret ? 'Secrets' : 'Variables'} must be pairs of a name and a value.` }
  if (Object.keys(value).length > MCP_ENV_LIMITS.variables) return { ok: false, error: `Use ${MCP_ENV_LIMITS.variables} variables or fewer.` }
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    const problem = envNameProblem(name)
    if (problem) return { ok: false, error: `"${shown(name)}" is not a valid variable name. ${problem}` }
    if (typeof entry !== 'string') return { ok: false, error: `The value of ${name} must be text.` }
    if (entry.includes('\0')) return { ok: false, error: `The value of ${name} contains a null character, which cannot be passed to a process.` }
    if (entry.length > MCP_ENV_LIMITS.value) return { ok: false, error: `The value of ${name} must be ${MCP_ENV_LIMITS.value.toLocaleString('en-US')} characters or fewer.` }
    if (secret && !entry) return { ok: false, error: `Enter a value for the secret ${name}.` }
    out[name] = entry
  }
  return { ok: true, value: out }
}

interface McpEnvironment {
  env: Record<string, string>
  secrets: Record<string, string>
  savedSecrets: string[]
}

/** The variables of a server as the page sends them: bounded, valid names, no name used twice. `serverId` is needed for saved secrets. */
function validateMcpEnvironment(value: { env?: unknown; secrets?: unknown; savedSecrets?: unknown }, serverId: string | undefined): Validated<McpEnvironment> {
  const env = variableMap(value.env, false)
  if (!env.ok) return env
  const secrets = variableMap(value.secrets, true)
  if (!secrets.ok) return secrets
  let saved: string[] = []
  if (value.savedSecrets !== undefined) {
    const list = value.savedSecrets
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) return { ok: false, error: 'Saved secrets must be a list of names.' }
    if (list.length > MCP_ENV_LIMITS.variables) return { ok: false, error: `Use ${MCP_ENV_LIMITS.variables} variables or fewer.` }
    if (list.length > 0 && serverId === undefined) return { ok: false, error: 'Saved secrets belong to a saved server.' }
    for (const name of list as string[]) {
      const problem = envNameProblem(name)
      if (problem) return { ok: false, error: `"${shown(name)}" is not a valid variable name. ${problem}` }
    }
    saved = list as string[]
  }
  const names = [...Object.keys(env.value), ...Object.keys(secrets.value), ...saved]
  if (names.length > MCP_ENV_LIMITS.variables) return { ok: false, error: `Use ${MCP_ENV_LIMITS.variables} variables or fewer.` }
  const repeated = [...duplicateEnvNames(names)]
  if (repeated.length > 0) return { ok: false, error: `The variable ${repeated[0]} is set more than once.` }
  const total = names.reduce((sum, name) => sum + name.length, 0)
    + [...Object.values(env.value), ...Object.values(secrets.value)].reduce((sum, entry) => sum + entry.length, 0)
  if (total > MCP_ENV_LIMITS.totalChars) return { ok: false, error: `Variables must total ${MCP_ENV_LIMITS.totalChars.toLocaleString('en-US')} characters or fewer.` }
  return { ok: true, value: { env: env.value, secrets: secrets.value, savedSecrets: saved } }
}

/** Untrusted input from the renderer to a connection test: a server's name, command, arguments and variables, bounded. */
export function validateMcpTestRequest(value: unknown): Validated<McpTestRequest> {
  if (!isRecord(value)) return { ok: false, error: 'Expected an MCP server configuration.' }
  const { id, name, command } = value
  if (id !== undefined && !isMcpServerId(id)) return { ok: false, error: 'The server id is not valid.' }
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Enter a name for the server.' }
  if (name.trim().length > MCP_LIMITS.name) return { ok: false, error: `The name must be ${MCP_LIMITS.name} characters or fewer.` }
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Enter the command that starts the server.' }
  if (command.trim().length > MCP_LIMITS.command) return { ok: false, error: `The command must be ${MCP_LIMITS.command} characters or fewer.` }
  if (CONTROL.test(command)) return { ok: false, error: 'The command contains a control character or line break.' }
  const args = validateMcpArguments(value.args)
  if (!args.ok) return args
  const environment = validateMcpEnvironment(value, id)
  if (!environment.ok) return environment
  const { env, secrets, savedSecrets } = environment.value
  return {
    ok: true,
    value: {
      ...(id !== undefined ? { id } : {}),
      name: name.trim(),
      command: command.trim(),
      args: args.value,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      ...(savedSecrets.length > 0 ? { savedSecrets } : {})
    }
  }
}

/** One secret value on its way to the credential store. */
export interface McpSecretSaveRequest {
  serverId: string
  name: string
  value: string
}

/** The reference to keep in the server's settings. The value is never returned. */
export type McpSecretSaveResult = { ok: true; ref: string } | { ok: false; message: string }

export interface McpSecretForgetRequest {
  serverId: string
  names: string[]
}

export function validateMcpSecretSave(value: unknown): Validated<McpSecretSaveRequest> {
  if (!isRecord(value)) return { ok: false, error: 'Expected a secret to save.' }
  const { serverId, name, value: secret } = value
  if (!isMcpServerId(serverId)) return { ok: false, error: 'The server id is not valid.' }
  if (typeof name !== 'string') return { ok: false, error: 'Enter a name for the variable.' }
  const problem = envNameProblem(name)
  if (problem) return { ok: false, error: `"${shown(name)}" is not a valid variable name. ${problem}` }
  if (typeof secret !== 'string' || !secret) return { ok: false, error: `Enter a value for the secret ${name}.` }
  if (secret.includes('\0')) return { ok: false, error: `The value of ${name} contains a null character, which cannot be passed to a process.` }
  if (secret.length > MCP_ENV_LIMITS.value) return { ok: false, error: `The value of ${name} must be ${MCP_ENV_LIMITS.value.toLocaleString('en-US')} characters or fewer.` }
  return { ok: true, value: { serverId, name, value: secret } }
}

export function validateMcpSecretForget(value: unknown): Validated<McpSecretForgetRequest> {
  if (!isRecord(value)) return { ok: false, error: 'Expected the secrets to remove.' }
  const { serverId, names } = value
  if (!isMcpServerId(serverId)) return { ok: false, error: 'The server id is not valid.' }
  if (!Array.isArray(names) || names.some((entry) => typeof entry !== 'string')) return { ok: false, error: 'Expected a list of variable names.' }
  if (names.length > MCP_ENV_LIMITS.variables) return { ok: false, error: `Use ${MCP_ENV_LIMITS.variables} variables or fewer.` }
  for (const name of names as string[]) {
    const problem = envNameProblem(name)
    if (problem) return { ok: false, error: `"${shown(name)}" is not a valid variable name. ${problem}` }
  }
  return { ok: true, value: { serverId, names: [...new Set(names as string[])] } }
}

// --- Hooks -------------------------------------------------------------------

export type HookEvent = HookConfig['event']

export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']

export const HOOK_LIMITS = { command: 4_000, matcher: 200 } as const

/** A hook that runs longer than this is stopped, and counts as no objection. */
export const HOOK_TIMEOUT_MS = 10_000

interface HookEventInfo {
  /** When it runs, in a sentence for the event picker. */
  when: string
  /** Whether an exit code 2 or a block decision stops anything. Only a tool that has not run yet can be stopped. */
  canBlock: boolean
  /** Whether the matcher applies. The other events have no tool to match. */
  matchesTools: boolean
}

export const HOOK_EVENT_INFO: Record<HookEvent, HookEventInfo> = {
  PreToolUse: { when: 'Before a tool runs, after you approve it. Can stop the tool.', canBlock: true, matchesTools: true },
  PostToolUse: { when: 'After a tool finishes. Cannot undo it.', canBlock: false, matchesTools: true },
  UserPromptSubmit: { when: 'When you send a message. Cannot stop it.', canBlock: false, matchesTools: false },
  Stop: { when: 'When a turn ends. Cannot stop anything.', canBlock: false, matchesTools: false }
}

/** Tools a hook matcher is most often aimed at; the matcher help names them. */
export const COMMON_HOOK_TOOLS: readonly string[] = [
  'run_command', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file', 'read_file', 'web_fetch', 'git_commit'
]

/** The matcher's alternatives: text separated by `|`, blanks dropped. */
export function matcherTerms(matcher: string | undefined): string[] {
  return (matcher ?? '').split('|').map((term) => term.trim()).filter(Boolean)
}

/**
 * The test every hook run applies: a hook with a matcher runs when the tool name contains any
 * of its terms, ignoring case. A hook without one runs for everything its event covers.
 */
export function hookMatches(matcher: string | undefined, name: string): boolean {
  const terms = matcherTerms(matcher)
  if (terms.length === 0) return true
  const lower = name.toLowerCase()
  return terms.some((term) => lower.includes(term.toLowerCase()))
}

/** What is wrong with a matcher as typed, or undefined when it is fine. */
export function matcherProblem(matcher: string): string | undefined {
  if (matcher.length > HOOK_LIMITS.matcher) return `The matcher must be ${HOOK_LIMITS.matcher} characters or fewer.`
  if (CONTROL.test(matcher)) return 'The matcher contains a control character.'
  const odd = /[^A-Za-z0-9_|\- ]/.exec(matcher)
  if (odd) return `"${odd[0]}" is not part of a tool name. The matcher is plain text, not a pattern; separate several tools with |.`
  if (matcher.trim() && matcherTerms(matcher).length === 0) return 'Add a tool name before or after the |.'
  return undefined
}

/** A hook as typed in the add form or on a saved row. */
export interface HookTestRequest {
  event: HookEvent
  matcher?: string
  command: string
}

export type HookOutcome = 'ran' | 'timed-out' | 'failed-to-start'

export interface HookTestResult {
  event: HookEvent
  /** The command that ran, exactly as saved. */
  command: string
  /** Where it ran, and whether that is the selected project or an empty temporary folder. */
  cwd: string
  cwdKind: 'project' | 'scratch'
  /** The JSON the hook received on stdin. */
  payload: string
  outcome: HookOutcome
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  /** Output beyond the cap was dropped. */
  truncated: boolean
  /** What a real run would do with this result. */
  decision: 'blocked' | 'allowed'
  /** Why it blocked, from stderr or the decision JSON. */
  reason?: string
  /** The hook asked to block, but this event cannot block anything. */
  blockIgnored?: boolean
  /** Why the command did not start. */
  startError?: string
}

export function validateHookTestRequest(value: unknown): Validated<HookTestRequest> {
  if (!isRecord(value)) return { ok: false, error: 'Expected a hook.' }
  const { event, matcher, command } = value
  if (typeof event !== 'string' || !HOOK_EVENTS.includes(event as HookEvent)) return { ok: false, error: 'Choose one of the four hook events.' }
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Enter the command to run.' }
  if (command.length > HOOK_LIMITS.command) return { ok: false, error: `The command must be ${HOOK_LIMITS.command.toLocaleString('en-US')} characters or fewer.` }
  if (command.includes('\0')) return { ok: false, error: 'The command contains a null character.' }
  if (matcher !== undefined && typeof matcher !== 'string') return { ok: false, error: 'The matcher must be text.' }
  if (typeof matcher === 'string') {
    const problem = matcherProblem(matcher)
    if (problem) return { ok: false, error: problem }
  }
  const trimmed = typeof matcher === 'string' ? matcher.trim() : ''
  return { ok: true, value: { event: event as HookEvent, ...(trimmed ? { matcher: trimmed } : {}), command: command.trim() } }
}
