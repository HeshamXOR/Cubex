import {
  KNOWN_AGENTS, connectionFor, connectionNeedsNode, describeAccount,
  type AgentDetection, type Connection, type KnownAgent
} from '../../../shared/agentCatalog'

/**
 * What one row of "Found on this PC" says, decided from what the check found. Kept apart from the component so the
 * wording and the rules (what can be added, when a sign-in button is offered) are tested without drawing anything.
 */

export type FoundState = 'missing' | 'problem' | 'signed-in' | 'signed-out' | 'unknown'

export interface FoundView {
  state: FoundState
  /** The line about the account: "Signed in with Claude subscription (ada@example.com)", "Not signed in", "Not installed". */
  account: string
  /** Where it was found when that was not on PATH: "Found in the Claude desktop app". */
  where?: string
  /** What adding it gives, said only where it falls short of the usual (an agent added through its ACP adapter does both). */
  capability?: string
  /** One thing to do before it is useful, in a sentence. May hold `code` spans. */
  hint?: string
  /** Adding it would set up something that cannot start on this computer, so the button waits. */
  blocked: boolean
  /** Whether to offer the Sign in button. */
  signIn: boolean
  /** What adding it sets up. */
  connection: Connection
}

export interface FoundEnvironment {
  /** npx can run, which the adapters of Claude Code and Codex need. */
  nodeFound: boolean
  /** Programs were looked for but not started. */
  localOnly: boolean
}

export function foundView(entry: KnownAgent, found: AgentDetection | undefined, environment: FoundEnvironment): FoundView {
  const { nodeFound, localOnly } = environment
  const connection = connectionFor(entry, nodeFound)
  const blocked = connectionNeedsNode(connection) && !nodeFound
  if (!found || !found.found) return { state: 'missing', account: 'Not installed', blocked, signIn: false, connection }

  const adapterMissing = entry.connection.kind === 'acp' && connection.kind === 'cli'
  const capability = connection.kind === 'acp' ? undefined : adapterMissing ? 'Gives opinions only. Install Node.js to let it take on tasks.' : 'Gives opinions only.'
  const program = entry.programs[0] ?? entry.id
  const said = { ...(found.via ? { where: `Found in ${found.via}` } : {}), ...(capability ? { capability } : {}) }

  if (found.problem) return { state: 'problem', account: found.problem, ...said, blocked, signIn: false, connection }

  const state: FoundState = found.account.state === 'signed-in' ? 'signed-in' : found.account.state === 'signed-out' ? 'signed-out' : 'unknown'
  const signIn = !!entry.signIn && state !== 'signed-in' && !localOnly
  let hint: string | undefined
  if (blocked) hint = 'Needs Node.js to run its adapter. Install Node.js, then choose Check again.'
  else if (state === 'signed-out' && !entry.signIn) hint = `To sign in, start \`${program}\` once in a terminal and follow its steps.`
  else if (state === 'unknown' && !localOnly) hint = 'Add it and use Test to see whether it answers.'
  return { state, account: describeAccount(found.account), ...said, ...(hint ? { hint } : {}), blocked, signIn, connection }
}

/** The agents that are installed first, each group in the order of the catalog. `also` names agents that are there though the check of programs cannot see them. */
export function sortFound(byId: ReadonlyMap<string, AgentDetection>, entries: readonly KnownAgent[] = KNOWN_AGENTS, also: ReadonlySet<string> = new Set()): KnownAgent[] {
  const installed = entries.filter((entry) => byId.get(entry.id)?.found === true || also.has(entry.id))
  return [...installed, ...entries.filter((entry) => !installed.includes(entry))]
}

/** The sentence about Node.js above the list. Claude Code is started directly; Codex and the npm adapters need it. */
export function nodeLine(node: { found: boolean; version?: string }): string {
  if (node.found) {
    return node.version
      ? `Node.js ${node.version} is installed. Codex runs through an adapter that it starts.`
      : 'Node.js is installed. Codex runs through an adapter that it starts.'
  }
  return 'Node.js is not installed. Codex needs it. Install Node.js, then choose Check again.'
}

/** When the check was made, as a clock time: "14:32". */
export function checkedAt(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}
