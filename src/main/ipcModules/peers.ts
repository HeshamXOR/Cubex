import { IPC } from '@shared/ipc'
import { knownAgent, signInCommand, type AgentSignInResult, type AgentsDetection } from '@shared/agentCatalog'
import {
  ACP_PRESETS, PEER_PRESETS, PEER_TEST_MESSAGE, newCliPeer, validatePeer,
  type AcpPresetStatus, type PeerPresetStatus, type PeerStatus, type PeerTestResult, type PeersOverview
} from '@shared/peers'
import { getSettings } from '../config'
import { providerRepo } from '../db'
import { runtimeLocation } from '../peers/antigravity/runtime'
import { detectAgents } from '../peers/detect'
import { consultProtocol, consultPrompt } from '../peers/framing'
import { clipReply, splitVerdict } from '../peers/output'
import { createScratch, locatePeer, peerEnvironment, removeScratch, runCliPeer, type PeerRun } from '../peers/peerRunner'
import { openSignIn } from '../peers/signIn'
import type { IpcContext } from './context'

/** Each test starts a real program or sends a real request: a stuck page must not be able to start dozens. */
const MAX_TESTS_AT_ONCE = 2
/** A test that has not been answered by now will not be: the person is waiting on a button. */
const TEST_TIMEOUT_MS = 120_000
/** An agent run through npx may download its package first, and then start a session before it answers. */
const ACP_TEST_TIMEOUT_MS = 240_000
const REPLY_PREVIEW_CHARS = 300
/** What a check of the computer found stays good for this long. Looking starts every program that is there. */
const DETECT_CACHE_MS = 2 * 60_000

/** Where the Antigravity runtime is, for the mark in the Add menu: the one Cubex installed, or one the agent names. */
function antigravityPath(peer: { command: string }): string | undefined {
  const location = runtimeLocation(peer, peerEnvironment({}))
  return 'path' in location ? location.path : undefined
}

function toResult(run: PeerRun): PeerTestResult {
  if (run.ok) {
    const { body } = splitVerdict(run.reply)
    return { ok: true, durationMs: run.durationMs, reply: clipReply(body || run.reply, REPLY_PREVIEW_CHARS), ...(run.note ? { note: run.note } : {}) }
  }
  return {
    ok: false,
    durationMs: run.durationMs,
    error: run.error ?? 'The agent did not answer.',
    ...(run.hint ? { hint: run.hint } : {}),
    ...(run.output ? { output: run.output } : {})
  }
}

export function register(ctx: IpcContext): void {
  let running = 0
  let detected: { at: number; localOnly: boolean; value: AgentsDetection } | undefined
  let detecting: Promise<AgentsDetection> | undefined

  // Which of the coding agents Cubex knows are on this computer, with version and account. The Settings page asks when it
  // opens and again on "Check again". A recent answer is reused, and two asks at once share one look.
  ctx.handle(IPC.peersDetect, (refresh: unknown): Promise<AgentsDetection> => {
    const localOnly = getSettings().privacy.localOnly
    if (refresh !== true && detected && detected.localOnly === localOnly && Date.now() - detected.at < DETECT_CACHE_MS) return Promise.resolve(detected.value)
    if (!detecting) {
      detecting = detectAgents({ localOnly })
        .then((value) => { detected = { at: Date.now(), localOnly, value }; return value })
        .finally(() => { detecting = undefined })
    }
    return detecting
  })

  // Opens a terminal window running the agent's own sign-in command. Only a command from the catalog, and only the program
  // Cubex found for it.
  ctx.handle(IPC.peersSignIn, (id: unknown): AgentSignInResult => {
    const entry = typeof id === 'string' ? knownAgent(id) : undefined
    if (!entry) throw new Error('That agent is not one Cubex knows.')
    if (getSettings().privacy.localOnly) return { ok: false, message: 'Local-only mode is on, so programs are not started. Turn it off under Privacy to sign in from here.' }
    const typed = signInCommand(entry)
    const program = entry.programs[0] ?? entry.id
    if (!entry.signIn || !typed) return { ok: false, message: `Start ${program} once in a terminal and follow its sign-in steps, then check again.` }
    const env = peerEnvironment({})
    let path: string | undefined
    for (const name of entry.programs) {
      path = locatePeer({ command: name })
      if (path) break
    }
    if (!path) return { ok: false, message: `${entry.name} was not found on this computer. Install it first.` }
    detected = undefined
    return openSignIn({ program: path, args: entry.signIn, env, typed })
  })

  // Whether each saved program is installed here and each saved model's provider is still set up, and whether the
  // programs the Add menu offers are installed, so it can say so. Looks for files only; nothing is started.
  ctx.handle(IPC.peersStatus, (): PeersOverview => {
    const settings = getSettings()
    const providers = providerRepo.list()
    const peers = (settings.peers?.list ?? []).map((peer): PeerStatus => {
      if (peer.kind === 'model') {
        const provider = providers.find((candidate) => candidate.id === peer.providerId)
        if (!provider) return { id: peer.id, found: false, problem: 'The provider of this model is no longer set up.' }
        if (!provider.enabled) return { id: peer.id, found: false, problem: `The provider "${provider.name}" is turned off.` }
        return { id: peer.id, found: true }
      }
      // The Antigravity runtime is the one Cubex installed, not a program on PATH: it is asked, and says why when it is not there.
      if (peer.kind === 'acp' && peer.preset === 'agy-acp') {
        const location = runtimeLocation(peer, peerEnvironment(peer))
        return 'path' in location ? { id: peer.id, found: true, path: location.path } : { id: peer.id, found: false, problem: location.problem }
      }
      const path = locatePeer(peer)
      return path ? { id: peer.id, found: true, path } : { id: peer.id, found: false, problem: `"${peer.command}" was not found on this computer.` }
    })
    const presets = PEER_PRESETS.filter((preset) => preset.id !== 'custom').map((preset): PeerPresetStatus => {
      const path = locatePeer(newCliPeer(preset.id, []))
      return { preset: preset.id, found: !!path, ...(path ? { path } : {}) }
    })
    const acpPresets = ACP_PRESETS.filter((preset) => preset.id !== 'custom').map((preset): AcpPresetStatus => {
      const path = preset.id === 'agy-acp' ? antigravityPath({ command: preset.command }) : locatePeer({ command: preset.command })
      return { preset: preset.id, found: !!path, ...(path ? { path } : {}) }
    })
    return { peers, presets, acpPresets, localOnly: settings.privacy.localOnly }
  })

  // The request is an agent as typed on the page, saved or not. A program is started the way a chat would start it,
  // but in an empty folder; a model gets a request of its own. Nothing of the page's choosing is run: the program is
  // the one the page names, with the arguments its kind has, as a chat would run it.
  ctx.handle(IPC.peersTest, async (request: unknown): Promise<PeerTestResult> => {
    const parsed = validatePeer(request)
    if (!parsed.ok) throw new Error(parsed.error)
    const peer = parsed.value
    if (running >= MAX_TESTS_AT_ONCE) return { ok: false, durationMs: 0, error: 'Other tests are still running.', hint: 'Wait for one to finish, then test again.' }
    if (peer.kind !== 'model' && getSettings().privacy.localOnly) {
      return { ok: false, durationMs: 0, error: 'Local-only mode is on, so programs are not started.', hint: 'Turn off local-only mode under Privacy to test this program.' }
    }
    running++
    try {
      if (peer.kind === 'model') {
        const run = await ctx.chat.askModelPeer(peer, { system: consultProtocol(false), history: [], message: PEER_TEST_MESSAGE }, undefined, AbortSignal.timeout(TEST_TIMEOUT_MS))
        return toResult(run)
      }
      if (peer.kind === 'acp') {
        const signal = AbortSignal.timeout(ACP_TEST_TIMEOUT_MS)
        return toResult(await ctx.chat.testAcpPeer(peer, PEER_TEST_MESSAGE, { signal, timeoutMs: ACP_TEST_TIMEOUT_MS }))
      }
      const folder = createScratch()
      try {
        return toResult(await runCliPeer(peer, { prompt: consultPrompt([], PEER_TEST_MESSAGE, false), cwd: folder, timeoutMs: TEST_TIMEOUT_MS }))
      } finally {
        removeScratch(folder)
      }
    } finally {
      running--
    }
  })
}
