import { KNOWN_AGENTS, type AgentAccount, type AgentDetection, type AgentsDetection } from '../../../../shared/agentCatalog'
import type { AcpPresetStatus, PeerConfig, PeerPresetStatus, PeersOverview, PeerStatus, PeerTestResult } from '../../../../shared/peers'
import type { CubexAPI, ToolActivity } from '../../../../shared/ipc'
import type { MessageTranscriptBlock } from '../../../../shared/messageTranscript'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/settings'
import { previewRuntimeInstalled } from './antigravity'
import type { PreviewSeed } from './index'

/**
 * Other agents in the browser preview.
 *   ?seed=1&agents=none        no agents yet; Claude Code is installed here, Antigravity is not
 *   ?seed=1&agents=configured  five agents: Claude Code, Antigravity (not installed), Codex (a program), Gemini (an ACP agent) and a model
 *   ?seed=1&thread=1&agents=thread
 *                              the same, with a chat in which Claude Code was asked twice and the model reported back
 * Extra: `agentstest=fail` makes every test fail the way a program that is not signed in does, `agentstest=slow`
 * takes six seconds, `agentstest=notasks` makes an agent that may take tasks report that it asks about nothing. Programs
 * are never started in the preview; the results are canned.
 *
 * What Settings finds on this computer (also on its own, without `agents`):
 *   ?seed=1&detect=mixed       the default: Claude Code signed in, Codex signed out, Gemini and OpenCode found with no account to read, the rest missing
 *   ?seed=1&detect=none        nothing installed, and no Node.js
 *   ?seed=1&detect=nonode      the same as mixed, without Node.js
 *   ?seed=1&detect=localonly   found but not started, so no versions and no accounts
 *   ?seed=1&detect=desktop     this PC with the Claude desktop app and nothing else: Claude Code is found inside the app and is not signed in
 *   ?seed=1&detect=slow        the check takes three seconds
 *   ?seed=1&detect=error       the check fails
 * Extra: `signin=fail` makes the sign-in window fail to open. A sign-in that opens counts as finished at the next check.
 */

const WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const MIN = 60_000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const claude: PeerConfig = { kind: 'cli', id: 'claude-code', name: 'Claude Code', enabled: true, preset: 'claude-code', command: 'claude', readProject: true }
const antigravity: PeerConfig = { kind: 'acp', id: 'antigravity', name: 'Antigravity', enabled: true, preset: 'agy-acp', command: 'agy_acp_server', args: [], readProject: true }
const codex: PeerConfig = { kind: 'cli', id: 'codex', name: 'Codex', enabled: true, preset: 'custom', command: 'codex', args: ['exec', '-'], input: 'stdin', passEnv: ['OPENAI_API_KEY'] }
const gemini: PeerConfig = { kind: 'acp', id: 'gemini', name: 'Gemini', enabled: true, preset: 'gemini', command: 'gemini', args: ['--acp'], readProject: true }
const reviewer: PeerConfig = { kind: 'model', id: 'gpt-review', name: 'GPT review', enabled: false, providerId: 'openai', model: 'gpt-5.5' }

/** Where each program is "installed". Antigravity is not, so the page shows how that reads. */
const INSTALLED: Record<string, string> = {
  claude: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
  codex: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
  gemini: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
  npx: 'C:\\Program Files\\nodejs\\npx.cmd',
  opencode: 'C:\\Users\\dev\\AppData\\Local\\Programs\\opencode\\opencode.exe'
}

function statusOf(peer: PeerConfig): PeerStatus {
  if (peer.kind === 'model') return { id: peer.id, found: true }
  // The runtime of an Antigravity agent is the one Cubex installs, so it follows the simulated install (see seeds/antigravity.ts).
  if (peer.kind === 'acp' && peer.preset === 'agy-acp') {
    return previewRuntimeInstalled() === false
      ? { id: peer.id, found: false, problem: 'Antigravity is not installed.' }
      : { id: peer.id, found: true, path: 'C:\\Users\\dev\\AppData\\Roaming\\Cubex\\antigravity\\runtime\\win32-x64\\versions\\65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9\\agy_acp_server.exe' }
  }
  const path = INSTALLED[peer.command]
  return path ? { id: peer.id, found: true, path } : { id: peer.id, found: false, problem: `"${peer.command}" was not found on this computer.` }
}

const presetStatuses = (): PeerPresetStatus[] => [
  { preset: 'claude-code', found: true, path: INSTALLED.claude },
  { preset: 'antigravity', found: false }
]

/** Codex runs through npx, so it is as installed as Node.js is. */
const acpStatuses = (): AcpPresetStatus[] => [
  { preset: 'claude-direct', found: true, path: 'C:\\Users\\dev\\AppData\\Local\\Claude\\claude-code\\2.1.293\\claude.exe' },
  { preset: 'agy-acp', found: previewRuntimeInstalled() === true },
  { preset: 'codex', found: true, path: INSTALLED.npx },
  { preset: 'gemini', found: true, path: INSTALLED.gemini },
  { preset: 'copilot', found: false },
  { preset: 'opencode', found: true, path: INSTALLED.opencode },
  { preset: 'cursor', found: false },
  { preset: 'goose', found: false },
  { preset: 'qwen', found: false }
]

// --- What a check of this computer finds ------------------------------------------------------------------

const PATHS: Record<string, string> = {
  'claude-code': INSTALLED.claude!, codex: INSTALLED.codex!, gemini: INSTALLED.gemini!, opencode: INSTALLED.opencode!
}
const VERSIONS: Record<string, string> = { 'claude-code': '2.1.4', codex: '0.46.0', gemini: '0.9.1', opencode: '0.15.2' }
const ACCOUNTS: Record<string, AgentAccount> = {
  'claude-code': { state: 'signed-in', label: 'Claude subscription', email: 'dev@example.com' },
  codex: { state: 'signed-out' }
}

function detection(mode: string, signedIn: ReadonlySet<string>): AgentsDetection {
  // A computer with the Claude desktop app and nothing else: Claude Code is found inside the app, and is not signed in yet.
  if (mode === 'desktop') {
    const agents = KNOWN_AGENTS.map((entry): AgentDetection => entry.id === 'claude-code'
      ? {
        id: entry.id, found: true, path: 'C:\\Users\\dev\\AppData\\Local\\Claude\\claude-code\\2.1.293\\claude.exe', via: 'the Claude desktop app', version: '2.1.293', probed: true,
        account: signedIn.has(entry.id) ? { state: 'signed-in', label: 'Claude subscription', email: 'dev@example.com' } : { state: 'signed-out' }
      }
      : { id: entry.id, found: false, account: { state: 'unknown' }, probed: false })
    return { agents, node: { found: false }, localOnly: false, checkedAt: Date.now() }
  }
  const nothing = mode === 'none'
  const localOnly = mode === 'localonly'
  const agents = KNOWN_AGENTS.map((entry): AgentDetection => {
    const path = nothing ? undefined : PATHS[entry.id]
    if (!path) return { id: entry.id, found: false, account: { state: 'unknown' }, probed: false }
    if (localOnly) return { id: entry.id, found: true, path, account: { state: 'unknown' }, probed: false }
    // Only Codex can be signed out here, and only an agent Cubex can read the account of changes when it is signed in.
    const account: AgentAccount = signedIn.has(entry.id) && entry.account ? { state: 'signed-in', label: 'ChatGPT account', email: 'dev@example.com' } : ACCOUNTS[entry.id] ?? { state: 'unknown' }
    return { id: entry.id, found: true, path, version: VERSIONS[entry.id]!, account, probed: true }
  })
  const node = nothing || mode === 'nonode' ? { found: false } : { found: true, ...(localOnly ? {} : { version: '22.11.0' }) }
  return { agents, node, localOnly, checkedAt: Date.now() }
}

function detectionApi(flags: URLSearchParams): Partial<CubexAPI> {
  const mode = flags.get('detect') ?? 'mixed'
  const signedIn = new Set<string>()
  return {
    detectAgents: async (refresh) => {
      await wait(mode === 'slow' ? 3_000 : refresh ? 800 : 120)
      if (mode === 'error') throw new Error('The check could not start. Close and reopen Cubex, then try again.')
      return detection(mode, signedIn)
    },
    signInAgent: async (id) => {
      await wait(500)
      if (flags.get('signin') === 'fail') {
        return { ok: false, message: 'The sign-in window could not be opened: access is denied. Run "codex login" in a terminal instead.' }
      }
      signedIn.add(id)
      return { ok: true, message: 'A terminal window opened. Finish signing in there, then come back to this window. Cubex checks again when you do.' }
    }
  }
}

function canned(peer: PeerConfig, mode: string | null): PeerTestResult {
  if (mode === 'fail') {
    return {
      ok: false, durationMs: 2_100,
      error: 'Invalid API key · Please run /login',
      hint: 'Sign in to the program first: start it once in a terminal and follow its login steps. If it uses an API key from your environment, add that variable under "Variables to pass".',
      output: 'Claude Code 2.1.4\nNot logged in.'
    }
  }
  if (peer.kind !== 'model' && !INSTALLED[peer.command]) {
    return { ok: false, durationMs: 14, error: `The command "${peer.command}" was not found. Install it, add it to PATH, or give the full path to the program.` }
  }
  // Only an agent that may take tasks is told whether it can.
  const note = peer.kind !== 'acp' || peer.canDelegate !== true ? undefined
    : mode === 'notasks' ? 'Can take research and review tasks, but not tasks that change the project: it has no mode in which it asks before it changes things (it offers: Build, Plan).'
      : 'Can take any kind of task. It works in its "Default" mode, which asks before it changes things.'
  return { ok: true, durationMs: peer.kind === 'model' ? 1_400 : 4_800, reply: 'OK', ...(note ? { note } : {}) }
}

// --- A chat in which the model asked another agent ----------------------------------------------

const now = Date.now()

const consult = (id: string, asked: string, peer: Omit<NonNullable<ToolActivity['peer']>, 'asked'>, reply: string): MessageTranscriptBlock => ({
  type: 'tool',
  tool: { id, name: 'consult_agent', phase: 'done', title: 'Ask Claude Code', detail: reply, peer: { ...peer, asked } }
})

const thread = (): unknown[] => [
  {
    id: 'a-user',
    role: 'user',
    text: 'Ask Claude Code whether retries should honor Retry-After before falling back to our own backoff, and agree on one rule with it.',
    createdAt: now - 5 * MIN
  },
  (() => {
    const blocks: MessageTranscriptBlock[] = [
      { type: 'text', text: 'I will put the question to Claude Code with the evidence from `src/upload/client.ts`, then answer what it says.' },
      consult('c1', 'Should a retry honor Retry-After before our own exponential backoff? src/upload/client.ts sends each chunk once and throws UploadError on any non-OK status. My position: honor the header first, and fall back to backoff with jitter only when it is missing. Retry 429 and every 4xx the server marks as temporary. What would you change?', { name: 'Claude Code', round: 1, of: 3, seconds: 41, verdict: 'partly' },
        'Honoring `Retry-After` first is right, but trust it only up to a cap. A server that answers `Retry-After: 3600` would stall an upload for an hour.\n\n- Parse both forms: seconds and an HTTP date.\n- Use `min(retryAfter, 30 s)`.\n- Fall back to your own exponential backoff only when the header is missing or unparseable.\n\nOne disagreement: your plan retries 4xx other than 429. Do not. A 400 will fail the same way every time.'),
      { type: 'text', text: 'Claude Code agrees on the order but wants a cap on the header, and objects to retrying other 4xx. I accept both. Sending the rule as I would write it.' },
      consult('c2', 'Agreed on the cap. The rule as I would write it: delay = Retry-After if present and parseable, else backoff(attempt); never wait longer than 30 seconds; retry 429 and 5xx only. Anything you would still change?', { name: 'Claude Code', round: 2, of: 3, seconds: 23, verdict: 'agree' },
        'That rule is sound. Cap at 30 seconds, jitter only the fallback delay (the server already chose the header delay), and retry 429 and 5xx only.\n\n```ts\nconst delay = parseRetryAfter(res) ?? backoff(attempt)\nawait sleep(Math.min(delay, 30_000))\n```'),
      {
        type: 'text',
        text: '**Agreed**\n\n- Honor `Retry-After` first, capped at 30 seconds.\n- Use exponential backoff with jitter only when the header is missing or unreadable.\n- Retry 429 and 5xx only. Other 4xx fail on the first attempt.\n\n**Still open**\n\n- Whether the cap should be configurable. Claude Code leans to a constant until someone needs more.\n\n**Strongest argument for each side**\n\n- Mine: a header is the server telling us exactly when it can take the request, so ignoring it wastes attempts.\n- Claude Code: an unbounded header is untrusted input and must not decide how long an upload hangs.'
      }
    ]
    return {
      id: 'a-agent',
      role: 'assistant',
      text: '',
      createdAt: now - 4 * MIN,
      blocks,
      toolCalls: blocks.flatMap((block) => (block.type === 'tool' ? [block.tool] : []))
    }
  })()
]

export const seed: PreviewSeed = {
  // Other seeds replace getSettings for every flag, so this one comes after them.
  order: 100,
  state: (flags) => {
    const mode = flags.get('agents')
    if (mode !== 'configured' && mode !== 'thread') return undefined
    return {
      peers: ['claude-code'],
      ...(mode === 'thread' ? { liveMessages: thread(), status: 'idle', statusDetail: undefined, pendingPermission: undefined, todos: [] } : {})
    }
  },
  api: (flags) => {
    const mode = flags.get('agents')
    const finds = flags.get('detect') !== null || mode !== null ? detectionApi(flags) : {}
    if (mode === null) return finds
    let settings: AppSettings | undefined
    const current = async (): Promise<AppSettings> => {
      if (settings) return settings
      const { SEED_WORKSPACE } = await import('../previewSeed')
      settings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, workspacePath: SEED_WORKSPACE ?? WORKSPACE, recentWorkspaces: [SEED_WORKSPACE ?? WORKSPACE] },
        peers: mode === 'none' ? { list: [], maxRounds: 3 } : { list: [claude, antigravity, codex, gemini, reviewer], maxRounds: 3 }
      }
      return settings
    }
    return {
      ...finds,
      getSettings: async () => current(),
      updateSettings: async (patch) => {
        settings = { ...(await current()), ...patch } as AppSettings
        return settings
      },
      getPeersStatus: async (): Promise<PeersOverview> => {
        const list = (await current()).peers?.list ?? []
        return { peers: list.map(statusOf), presets: presetStatuses(), acpPresets: acpStatuses(), localOnly: false }
      },
      testPeer: async (peer) => {
        const test = flags.get('agentstest')
        await wait(test === 'slow' ? 6_000 : 900)
        return canned(peer, test)
      }
    }
  }
}
