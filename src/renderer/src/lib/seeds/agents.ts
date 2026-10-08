import type { PeerConfig, PeerPresetStatus, PeersOverview, PeerStatus, PeerTestResult } from '../../../../shared/peers'
import type { ToolActivity } from '../../../../shared/ipc'
import type { MessageTranscriptBlock } from '../../../../shared/messageTranscript'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/settings'
import type { PreviewSeed } from './index'

/**
 * Other agents in the browser preview.
 *   ?seed=1&agents=none        no agents yet; Claude Code is installed here, Antigravity is not
 *   ?seed=1&agents=configured  four agents: Claude Code, Antigravity (not installed), Codex (a program) and a model
 *   ?seed=1&thread=1&agents=thread
 *                              the same, with a chat in which Claude Code was asked twice and the model reported back
 * Extra: `agentstest=fail` makes every test fail the way a program that is not signed in does, `agentstest=slow`
 * takes six seconds. Programs are never started in the preview; the results are canned.
 */

const WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const MIN = 60_000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const claude: PeerConfig = { kind: 'cli', id: 'claude-code', name: 'Claude Code', enabled: true, preset: 'claude-code', command: 'claude', readProject: true }
const antigravity: PeerConfig = { kind: 'cli', id: 'antigravity', name: 'Antigravity', enabled: true, preset: 'antigravity', command: 'agy' }
const codex: PeerConfig = { kind: 'cli', id: 'codex', name: 'Codex', enabled: true, preset: 'custom', command: 'codex', args: ['exec', '-'], input: 'stdin', passEnv: ['OPENAI_API_KEY'] }
const reviewer: PeerConfig = { kind: 'model', id: 'gpt-review', name: 'GPT review', enabled: false, providerId: 'openai', model: 'gpt-5.5' }

/** Where each program is "installed". Antigravity is not, so the page shows how that reads. */
const INSTALLED: Record<string, string> = {
  claude: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
  codex: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
}

function statusOf(peer: PeerConfig): PeerStatus {
  if (peer.kind === 'model') return { id: peer.id, found: true }
  const path = INSTALLED[peer.command]
  return path ? { id: peer.id, found: true, path } : { id: peer.id, found: false, problem: `"${peer.command}" was not found on this computer.` }
}

const presetStatuses = (): PeerPresetStatus[] => [
  { preset: 'claude-code', found: true, path: INSTALLED.claude },
  { preset: 'antigravity', found: false }
]

function canned(peer: PeerConfig, mode: string | null): PeerTestResult {
  if (mode === 'fail') {
    return {
      ok: false, durationMs: 2_100,
      error: 'Invalid API key · Please run /login',
      hint: 'Sign in to the program first: start it once in a terminal and follow its login steps. If it uses an API key from your environment, add that variable under "Variables to pass".',
      output: 'Claude Code 2.1.4\nNot logged in.'
    }
  }
  if (peer.kind === 'cli' && !INSTALLED[peer.command]) {
    return { ok: false, durationMs: 14, error: `The command "${peer.command}" was not found. Install it, add it to PATH, or give the full path to the program.` }
  }
  return { ok: true, durationMs: peer.kind === 'model' ? 1_400 : 4_800, reply: 'OK' }
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
    if (mode === null) return {}
    let settings: AppSettings | undefined
    const current = async (): Promise<AppSettings> => {
      if (settings) return settings
      const { SEED_WORKSPACE } = await import('../previewSeed')
      settings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, workspacePath: SEED_WORKSPACE ?? WORKSPACE, recentWorkspaces: [SEED_WORKSPACE ?? WORKSPACE] },
        peers: mode === 'none' ? { list: [], maxRounds: 3 } : { list: [claude, antigravity, codex, reviewer], maxRounds: 3 }
      }
      return settings
    }
    return {
      getSettings: async () => current(),
      updateSettings: async (patch) => {
        settings = { ...(await current()), ...patch } as AppSettings
        return settings
      },
      getPeersStatus: async (): Promise<PeersOverview> => {
        const list = (await current()).peers?.list ?? []
        return { peers: list.map(statusOf), presets: presetStatuses(), localOnly: false }
      },
      testPeer: async (peer) => {
        const test = flags.get('agentstest')
        await wait(test === 'slow' ? 6_000 : 900)
        return canned(peer, test)
      }
    }
  }
}
