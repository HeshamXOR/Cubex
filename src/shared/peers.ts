import { envNameProblem } from './policy'

/**
 * Other agents: programs and models the chat's model can ask for a second opinion and talk with until they agree
 * (the `consult_agent` tool). Pure on purpose: the Settings page checks a peer with the same rules the main process
 * enforces, and the main process never trusts what the page sends.
 *
 * "Peer" is the name in code. The person sees "other agents".
 */

type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

/** The name of the tool the model calls. Shared so the permission prompt, the thread and the prompt all agree on it. */
export const CONSULT_TOOL = 'consult_agent'

export type PeerPresetId = 'claude-code' | 'antigravity' | 'custom'

interface PeerBase {
  /** Stable key: the model names it in a call, a chat remembers it, and saved history refers to it. */
  id: string
  /** What the person and the model call it. */
  name: string
  enabled: boolean
}

/** A program on this computer that answers one message and exits. */
export interface CliPeer extends PeerBase {
  kind: 'cli'
  preset: PeerPresetId
  /** A program name looked up on PATH, or a full path. */
  command: string
  /** Custom commands only: the arguments that come before the message. A preset knows its own. */
  args?: string[]
  /** Custom commands only: whether the message goes to standard input or is added as the last argument. */
  input?: 'stdin' | 'argument'
  /** Claude Code only: let it read this project's files. It is never allowed to change them. */
  readProject?: boolean
  /** Names of variables from Cubex's own environment, normally kept from programs, to pass to this one. */
  passEnv?: string[]
}

/** A model of one of the providers set up in Cubex, asked a question with nothing but the message. */
export interface ModelPeer extends PeerBase {
  kind: 'model'
  providerId: string
  model: string
}

export type PeerConfig = CliPeer | ModelPeer

export interface PeerSettings {
  list: PeerConfig[]
  /** The most messages one reply may send to a single agent. */
  maxRounds: number
}

export const PEER_LIMITS = {
  peers: 8,
  id: 40,
  name: 60,
  command: 1_024,
  args: 32,
  argChars: 2_048,
  passEnv: 16,
  providerId: 200,
  model: 300,
  /** What the model may say to an agent in one call. Programs that take the message as an argument have to stay under a command line's limit. */
  messageChars: 24_000,
  rounds: { min: 1, max: 6, default: 3 }
} as const

export const DEFAULT_PEER_SETTINGS: PeerSettings = { list: [], maxRounds: PEER_LIMITS.rounds.default }

// --- Presets -----------------------------------------------------------------

export interface PeerPreset {
  id: PeerPresetId
  /** Shown in the Add menu. */
  label: string
  /** The name a new peer starts with. */
  name: string
  /** The program it runs. */
  command: string
  /** One sentence for the Add menu. */
  description: string
}

export const PEER_PRESETS: readonly PeerPreset[] = [
  { id: 'claude-code', label: 'Claude Code', name: 'Claude Code', command: 'claude', description: 'Anthropic\'s coding agent, run from its command line.' },
  { id: 'antigravity', label: 'Antigravity', name: 'Antigravity', command: 'agy', description: 'Google\'s agy command line.' },
  { id: 'custom', label: 'Another program', name: '', command: '', description: 'Any command that reads a message and prints a reply, such as Codex or Gemini.' }
]

export function peerPreset(id: PeerPresetId): PeerPreset {
  return PEER_PRESETS.find((preset) => preset.id === id) ?? PEER_PRESETS[2]!
}

/** What Claude Code is asked to do with the message it receives on standard input. */
export const CLAUDE_CODE_INSTRUCTION = 'Respond to the consultation message supplied on standard input.'

/**
 * The arguments Claude Code is started with. Tools are limited to reading (or removed altogether), project settings
 * and their hooks are not loaded, no MCP servers start, and nothing is saved to disk. It never gets
 * --dangerously-skip-permissions, and a tool that would need permission is refused because nobody is there to approve it.
 */
export function claudeCodeArguments(readProject: boolean): string[] {
  return [
    '-p', CLAUDE_CODE_INSTRUCTION,
    '--output-format', 'json',
    '--tools', readProject ? 'Read,Grep,Glob' : '',
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns', readProject ? '12' : '3'
  ]
}

/** Antigravity takes the message as the value of -p, so it goes last. */
export const ANTIGRAVITY_ARGUMENTS: readonly string[] = ['--output-format', 'json', '-p']

/** How a program's output is read. Presets print JSON of a known shape; anything else is plain text. */
export type PeerOutputFormat = 'claude-json' | 'agy-json' | 'text'

/** What a CLI peer is started with, in one place for the runner, the page's "runs" line and the tests. */
export interface PeerCommandLine {
  command: string
  args: string[]
  input: 'stdin' | 'argument'
  format: PeerOutputFormat
  /** True when the program can look at the project: Claude Code with its read-only tools. */
  readsProject: boolean
}

export function peerCommandLine(peer: CliPeer): PeerCommandLine {
  switch (peer.preset) {
    case 'claude-code': {
      const readsProject = peer.readProject === true
      return { command: peer.command, args: claudeCodeArguments(readsProject), input: 'stdin', format: 'claude-json', readsProject }
    }
    case 'antigravity':
      return { command: peer.command, args: [...ANTIGRAVITY_ARGUMENTS], input: 'argument', format: 'agy-json', readsProject: false }
    default:
      return { command: peer.command, args: [...(peer.args ?? [])], input: peer.input ?? 'stdin', format: 'text', readsProject: false }
  }
}

// --- Checks ------------------------------------------------------------------

const PEER_ID = /^[A-Za-z0-9_-]+$/
const CONTROL = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PEER_LIMITS.id && PEER_ID.test(value)
}

/** A name safe to quote in a message, whatever the page sent. */
function shown(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

function validateArguments(value: unknown): Validated<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return { ok: false, error: 'Arguments must be a list of text.' }
  if (value.length > PEER_LIMITS.args) return { ok: false, error: `Use ${PEER_LIMITS.args} arguments or fewer.` }
  for (const [index, entry] of (value as string[]).entries()) {
    if (entry.includes('\0')) return { ok: false, error: `Argument ${index + 1} contains a null character, which cannot be passed to a program.` }
    if (entry.length > PEER_LIMITS.argChars) return { ok: false, error: `Argument ${index + 1} must be ${PEER_LIMITS.argChars.toLocaleString('en-US')} characters or fewer.` }
  }
  return { ok: true, value: value as string[] }
}

function validatePassEnv(value: unknown): Validated<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return { ok: false, error: 'Variables to pass must be a list of names.' }
  if (value.length > PEER_LIMITS.passEnv) return { ok: false, error: `Pass ${PEER_LIMITS.passEnv} variables or fewer.` }
  const seen = new Set<string>()
  for (const name of value as string[]) {
    const problem = envNameProblem(name)
    if (problem) return { ok: false, error: `"${shown(name)}" is not a valid variable name. ${problem}` }
    if (seen.has(name.toLowerCase())) return { ok: false, error: `The variable ${name} is listed twice.` }
    seen.add(name.toLowerCase())
  }
  return { ok: true, value: value.length > 0 ? (value as string[]) : undefined }
}

/**
 * Check one peer as the page sends it and return it with only the fields its kind has. Messages are written for the
 * form: they say what to change.
 */
export function validatePeer(value: unknown): Validated<PeerConfig> {
  if (!isRecord(value)) return { ok: false, error: 'Expected an agent.' }
  const { id, name, enabled } = value
  if (!isPeerId(id)) return { ok: false, error: 'The agent id is not valid.' }
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Enter a name for the agent.' }
  if (name.trim().length > PEER_LIMITS.name) return { ok: false, error: `The name must be ${PEER_LIMITS.name} characters or fewer.` }
  if (CONTROL.test(name)) return { ok: false, error: 'The name contains a control character or line break.' }
  if (typeof enabled !== 'boolean') return { ok: false, error: 'The agent must be either on or off.' }
  const base = { id, name: name.trim(), enabled }

  if (value.kind === 'model') {
    const { providerId, model } = value
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > PEER_LIMITS.providerId) return { ok: false, error: 'Choose a provider.' }
    if (typeof model !== 'string' || !model.trim() || model.length > PEER_LIMITS.model) return { ok: false, error: 'Choose a model.' }
    return { ok: true, value: { ...base, kind: 'model', providerId, model: model.trim() } }
  }

  if (value.kind !== 'cli') return { ok: false, error: 'The agent is neither a program nor a model.' }
  const preset = value.preset
  if (preset !== 'claude-code' && preset !== 'antigravity' && preset !== 'custom') return { ok: false, error: 'The kind of program is not known.' }
  const command = value.command
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Enter the program to run.' }
  if (command.trim().length > PEER_LIMITS.command) return { ok: false, error: `The program must be ${PEER_LIMITS.command} characters or fewer.` }
  if (CONTROL.test(command)) return { ok: false, error: 'The program contains a control character or line break.' }
  const passEnv = validatePassEnv(value.passEnv)
  if (!passEnv.ok) return passEnv
  const peer: CliPeer = { ...base, kind: 'cli', preset, command: command.trim(), ...(passEnv.value ? { passEnv: passEnv.value } : {}) }

  if (preset === 'claude-code') {
    if (value.readProject !== undefined && typeof value.readProject !== 'boolean') return { ok: false, error: 'Reading the project must be either on or off.' }
    if (value.readProject === true) peer.readProject = true
  } else if (preset === 'custom') {
    const args = validateArguments(value.args)
    if (!args.ok) return args
    if (args.value && args.value.length > 0) peer.args = args.value
    if (value.input !== undefined && value.input !== 'stdin' && value.input !== 'argument') return { ok: false, error: 'Choose how the message is given to the program.' }
    peer.input = value.input === 'argument' ? 'argument' : 'stdin'
  }
  return { ok: true, value: peer }
}

/** A whole number of rounds within what a reply can spend, whatever was stored. */
export function clampRounds(value: unknown): number {
  const { min, max, default: fallback } = PEER_LIMITS.rounds
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/**
 * Settings as they are kept: peers that fail the checks above are dropped, an id never appears twice, and the list
 * and the rounds stay inside their limits. Anything else a hand-edited file holds is ignored.
 */
export function normalizePeerSettings(value: unknown): PeerSettings {
  const stored = isRecord(value) ? value : {}
  const list: PeerConfig[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(stored.list) ? stored.list : []) {
    if (list.length >= PEER_LIMITS.peers) break
    const checked = validatePeer(entry)
    if (!checked.ok || seen.has(checked.value.id)) continue
    seen.add(checked.value.id)
    list.push(checked.value)
  }
  return { list, maxRounds: clampRounds(stored.maxRounds) }
}

/** The peers of these ids that exist and are on, in the order asked and each once. For a chat's choice of agents. */
export function enabledPeers(settings: PeerSettings | undefined, ids: readonly string[] | undefined): PeerConfig[] {
  if (!settings || !ids) return []
  const out: PeerConfig[] = []
  for (const id of ids) {
    const peer = settings.list.find((candidate) => candidate.id === id)
    if (peer?.enabled && !out.includes(peer)) out.push(peer)
  }
  return out
}

/** A list of peer ids from a request or stored choice: bounded, valid, no repeats. Whether they exist is checked where they are used. */
export function cleanPeerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    if (ids.length >= PEER_LIMITS.peers) break
    if (isPeerId(entry) && !ids.includes(entry)) ids.push(entry)
  }
  return ids
}

// --- Making and naming -------------------------------------------------------

/** A key from a display name: lower case words joined by dashes. */
export function peerSlug(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, PEER_LIMITS.id - 4)
  return slug || 'agent'
}

/** The first of base, base-2, base-3 that no peer uses. */
export function uniquePeerId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** A new program peer from a preset: on, with the preset's name and command. A second of the same preset gets a numbered name. */
export function newCliPeer(preset: PeerPresetId, existing: readonly PeerConfig[]): CliPeer {
  const entry = peerPreset(preset)
  const ids = existing.map((peer) => peer.id)
  const names = new Set(existing.map((peer) => peer.name.toLowerCase()))
  let name = entry.name
  for (let n = 2; name && names.has(name.toLowerCase()); n++) name = `${entry.name} ${n}`
  const id = uniquePeerId(preset === 'custom' ? 'custom' : preset, ids)
  return { kind: 'cli', id, name, enabled: true, preset, command: entry.command, ...(preset === 'custom' ? { input: 'stdin' as const } : {}) }
}

export function newModelPeer(providerId: string, model: string, label: string, existing: readonly PeerConfig[]): ModelPeer {
  const base = peerSlug(label || model)
  return { kind: 'model', id: uniquePeerId(base, existing.map((peer) => peer.id)), name: label || model, enabled: true, providerId, model }
}

// --- What the thread shows ---------------------------------------------------

export type PeerVerdict = 'agree' | 'partly' | 'disagree'

/** One message to an agent and its answer, as the thread's card shows it. Kept in saved history. */
export interface PeerActivity {
  /** The agent's name. */
  name: string
  /** Which message to this agent in this reply: 1, 2, 3. */
  round: number
  /** The most messages one reply may send to it. */
  of: number
  seconds?: number
  verdict?: PeerVerdict
  /** What the model sent, as far as the card shows it: the person approved this text, and can read it again here. */
  asked?: string
}

/** How much of a message the card keeps. */
export const PEER_ASKED_CHARS = 4_000

export const PEER_VERDICT_LABEL: Record<PeerVerdict, string> = { agree: 'Agrees', partly: 'Partly agrees', disagree: 'Disagrees' }

/** Only the fields of a peer activity, each checked, from anything a saved file or an event holds. */
export function sanitizePeerActivity(value: unknown): PeerActivity | undefined {
  if (!isRecord(value)) return undefined
  const name = typeof value.name === 'string' ? value.name.replace(CONTROL, ' ').trim().slice(0, PEER_LIMITS.name) : ''
  const whole = (n: unknown, max: number): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max ? n : undefined)
  const round = whole(value.round, 1_000)
  const of = whole(value.of, 1_000)
  if (!name || round === undefined || of === undefined) return undefined
  const seconds = typeof value.seconds === 'number' && Number.isFinite(value.seconds) && value.seconds >= 0 && value.seconds <= 86_400 ? Math.round(value.seconds) : undefined
  const verdict = value.verdict === 'agree' || value.verdict === 'partly' || value.verdict === 'disagree' ? value.verdict : undefined
  // Line breaks and tabs stay; every other control character goes.
  const asked = typeof value.asked === 'string' ? value.asked.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, PEER_ASKED_CHARS).trim() : ''
  return { name, round, of, ...(seconds !== undefined ? { seconds } : {}), ...(verdict ? { verdict } : {}), ...(asked ? { asked } : {}) }
}

// --- Messages between the window and the main process --------------------------

/** Whether a program peer can be started from this computer. */
export interface PeerStatus {
  id: string
  /** A program that was found on this computer, or a model whose provider is set up and on. */
  found: boolean
  /** Where the program was found. */
  path?: string
  /** Why it cannot be used, in one sentence. */
  problem?: string
}

/** Whether each program the Add menu offers is installed here, so it can say so. */
export interface PeerPresetStatus {
  preset: PeerPresetId
  found: boolean
  path?: string
}

export interface PeersOverview {
  peers: PeerStatus[]
  presets: PeerPresetStatus[]
  /** Local-only mode is on: programs are not started, and models must be local. */
  localOnly: boolean
}

export interface PeerTestResult {
  ok: boolean
  durationMs: number
  /** What the agent said, clipped. */
  reply?: string
  /** One sentence on what went wrong. */
  error?: string
  /** What to do about it. */
  hint?: string
  /** The program's own error output, redacted and clipped. Present only when it printed something. */
  output?: string
}

/** The message a test sends. */
export const PEER_TEST_MESSAGE = 'Reply with the single word OK.'

/** How a peer is described in one line, for the list: what runs, or which model. */
export function describePeer(peer: PeerConfig, providerName?: string): string {
  if (peer.kind === 'model') return providerName ? `${peer.model} on ${providerName}` : peer.model
  const line = peerCommandLine(peer)
  return line.readsProject ? `${peer.command}, can read this project` : peer.command
}
