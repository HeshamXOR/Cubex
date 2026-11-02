import { acpPreset, type AcpPresetId, type PeerConfig, type PeerPresetId } from './peers'

/**
 * The coding agents Cubex knows by name: how to find each on this computer, how to ask who is signed in, and what adding
 * it sets up. Pure on purpose, so the Settings page and the main process read the same list.
 *
 * Cubex never signs in for an agent and never touches its saved login. Each agent is the vendor's own program, which
 * keeps the account (a Claude or ChatGPT subscription, a Google or GitHub login) where the vendor keeps it. Cubex starts
 * the program, and that is how the subscription is used: no key is copied, and no key is needed.
 */

/** Which command tells whether the program is signed in. Only the ones whose output is known are listed. */
export type AccountProbe = 'claude' | 'codex'

export type Connection = { kind: 'acp'; preset: AcpPresetId } | { kind: 'cli'; preset: PeerPresetId }

export interface KnownAgent {
  /** Stable key, not the id of a saved agent. */
  id: string
  name: string
  vendor: string
  /** Program names to look for, the first that exists wins. */
  programs: readonly string[]
  /** How the account is read. Absent: Cubex cannot tell, and says so. */
  account?: AccountProbe
  /** The arguments of the program that sign it in, for the "Sign in" button. Absent: the page says to start it once and follow its steps. */
  signIn?: readonly string[]
  /** Where to get it. */
  installUrl: string
  /** What adding it sets up. */
  connection: Connection
  /** When the connection runs through npx and Node.js is not installed, this one is used instead. */
  withoutNode?: Connection
  /** Connections this agent was set up with before, which still belong to it. */
  alsoConnections?: readonly Connection[]
}

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', programs: ['claude'], account: 'claude', signIn: ['auth', 'login'],
    installUrl: 'https://claude.com/product/claude-code',
    // Cubex talks to Claude Code itself, so Node.js is not needed. The adapter from npm and the one-shot command line are older ways in.
    connection: { kind: 'acp', preset: 'claude-direct' },
    alsoConnections: [{ kind: 'acp', preset: 'claude' }, { kind: 'cli', preset: 'claude-code' }]
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', programs: ['codex'], account: 'codex', signIn: ['login'],
    installUrl: 'https://developers.openai.com/codex/cli',
    connection: { kind: 'acp', preset: 'codex' }
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', programs: ['gemini'],
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    connection: { kind: 'acp', preset: 'gemini' }
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'Anomaly', programs: ['opencode'], signIn: ['auth', 'login'],
    installUrl: 'https://opencode.ai',
    connection: { kind: 'acp', preset: 'opencode' }
  },
  {
    id: 'cursor', name: 'Cursor', vendor: 'Cursor', programs: ['cursor-agent'], signIn: ['login'],
    installUrl: 'https://cursor.com/cli',
    connection: { kind: 'acp', preset: 'cursor' }
  },
  {
    id: 'copilot', name: 'GitHub Copilot', vendor: 'GitHub', programs: ['copilot'],
    installUrl: 'https://github.com/github/copilot-cli',
    connection: { kind: 'acp', preset: 'copilot' }
  },
  {
    id: 'goose', name: 'Goose', vendor: 'Block', programs: ['goose'],
    installUrl: 'https://github.com/block/goose',
    connection: { kind: 'acp', preset: 'goose' }
  },
  {
    id: 'qwen', name: 'Qwen Code', vendor: 'Alibaba', programs: ['qwen'],
    installUrl: 'https://github.com/QwenLM/qwen-code',
    connection: { kind: 'acp', preset: 'qwen' }
  },
  {
    id: 'antigravity', name: 'Antigravity', vendor: 'Google', programs: ['agy'],
    installUrl: 'https://antigravity.google',
    // Google's agent runtime, which Cubex installs and signs in to itself, because the desktop app has nothing to talk to. The
    // agy command line is an older way in, and still belongs to this entry.
    connection: { kind: 'acp', preset: 'agy-acp' },
    alsoConnections: [{ kind: 'cli', preset: 'antigravity' }]
  }
]

export function knownAgent(id: string): KnownAgent | undefined {
  return KNOWN_AGENTS.find((entry) => entry.id === id)
}

function isConnection(connection: Connection | undefined, kind: string, preset: string): boolean {
  return connection !== undefined && connection.kind === kind && connection.preset === preset
}

/** A program's own name, without its folder or the extension Windows adds: "C:\npm\codex.cmd" is "codex". */
function programName(command: string): string {
  const last = command.trim().split(/[\\/]/).pop() ?? ''
  return last.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase()
}

/**
 * The catalog entry a saved agent belongs to, so its row can show the account the program is signed in with. A preset
 * says it outright; otherwise the program the agent starts does, so a program saved by hand as "codex" is still Codex.
 */
export function catalogIdOfPeer(peer: PeerConfig): string | undefined {
  if (peer.kind === 'model') return undefined
  const direct = KNOWN_AGENTS.find((entry) => isConnection(entry.connection, peer.kind, peer.preset)
    || isConnection(entry.withoutNode, peer.kind, peer.preset)
    || (entry.alsoConnections ?? []).some((connection) => isConnection(connection, peer.kind, peer.preset)))
  if (direct) return direct.id
  const name = programName(peer.command)
  return KNOWN_AGENTS.find((entry) => entry.programs.includes(name))?.id
}

/** Whether starting this connection needs npx, which comes with Node.js. */
export function connectionNeedsNode(connection: Connection): boolean {
  return connection.kind === 'acp' && acpPreset(connection.preset).npm === true
}

/** What adding this agent sets up on this computer: the ACP adapter when Node.js is there to run it, else the command line. */
export function connectionFor(entry: KnownAgent, nodeFound: boolean): Connection {
  return connectionNeedsNode(entry.connection) && !nodeFound && entry.withoutNode ? entry.withoutNode : entry.connection
}

/** What a person types to sign in, or undefined when the program has no such command. */
export function signInCommand(entry: KnownAgent): string | undefined {
  const program = entry.programs[0]
  return entry.signIn && program ? [program, ...entry.signIn].join(' ') : undefined
}

// --- What a check of this computer found -----------------------------------------------

export interface AgentAccount {
  state: 'signed-in' | 'signed-out' | 'unknown'
  /** What it is signed in with, in the program's own terms: "Claude subscription", "ChatGPT account", "API key". */
  label?: string
  email?: string
}

export interface AgentDetection {
  /** The id of the catalog entry. */
  id: string
  found: boolean
  /** Where the program was found. */
  path?: string
  /** Where it was found when that was not on PATH, as the end of "Found in ...": "the Claude desktop app". */
  via?: string
  version?: string
  account: AgentAccount
  /** The program was started and answered, so its version and account were read. */
  probed: boolean
  /** Why it could not be checked, in one sentence. */
  problem?: string
}

export interface AgentsDetection {
  agents: AgentDetection[]
  /** Whether npx can run, which the adapters of Claude Code and Codex need. */
  node: { found: boolean; version?: string }
  /** Local-only mode is on: programs were looked for, not started. */
  localOnly: boolean
  checkedAt: number
}

/** What asking for a sign-in window came to. A refusal says why and what to do. */
export interface AgentSignInResult {
  ok: boolean
  message: string
}

/** The account in one line for a row: "Signed in with Claude subscription (name@example.com)". */
export function describeAccount(account: AgentAccount): string {
  switch (account.state) {
    case 'signed-in':
      return `Signed in${account.label ? ` with ${account.label}` : ''}${account.email ? ` (${account.email})` : ''}`
    case 'signed-out':
      return 'Not signed in'
    default:
      return 'Sign-in not checked'
  }
}
