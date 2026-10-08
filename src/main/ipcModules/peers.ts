import { IPC } from '@shared/ipc'
import {
  PEER_PRESETS, PEER_TEST_MESSAGE, newCliPeer, validatePeer,
  type PeerPresetStatus, type PeerStatus, type PeerTestResult, type PeersOverview
} from '@shared/peers'
import { getSettings } from '../config'
import { providerRepo } from '../db'
import { consultProtocol, consultPrompt } from '../peers/framing'
import { clipReply, splitVerdict } from '../peers/output'
import { createScratch, locatePeer, removeScratch, runCliPeer, type PeerRun } from '../peers/peerRunner'
import type { IpcContext } from './context'

/** Each test starts a real program or sends a real request: a stuck page must not be able to start dozens. */
const MAX_TESTS_AT_ONCE = 2
/** A test that has not been answered by now will not be: the person is waiting on a button. */
const TEST_TIMEOUT_MS = 120_000
const REPLY_PREVIEW_CHARS = 300

function toResult(run: PeerRun): PeerTestResult {
  if (run.ok) {
    const { body } = splitVerdict(run.reply)
    return { ok: true, durationMs: run.durationMs, reply: clipReply(body || run.reply, REPLY_PREVIEW_CHARS) }
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
      const path = locatePeer(peer)
      return path ? { id: peer.id, found: true, path } : { id: peer.id, found: false, problem: `"${peer.command}" was not found on this computer.` }
    })
    const presets = PEER_PRESETS.filter((preset) => preset.id !== 'custom').map((preset): PeerPresetStatus => {
      const path = locatePeer(newCliPeer(preset.id, []))
      return { preset: preset.id, found: !!path, ...(path ? { path } : {}) }
    })
    return { peers, presets, localOnly: settings.privacy.localOnly }
  })

  // The request is an agent as typed on the page, saved or not. A program is started the way a chat would start it,
  // but in an empty folder; a model gets a request of its own. Nothing of the page's choosing is run: the program is
  // the one the page names, with the arguments its kind has, as a chat would run it.
  ctx.handle(IPC.peersTest, async (request: unknown): Promise<PeerTestResult> => {
    const parsed = validatePeer(request)
    if (!parsed.ok) throw new Error(parsed.error)
    const peer = parsed.value
    if (running >= MAX_TESTS_AT_ONCE) return { ok: false, durationMs: 0, error: 'Other tests are still running.', hint: 'Wait for one to finish, then test again.' }
    if (peer.kind === 'cli' && getSettings().privacy.localOnly) {
      return { ok: false, durationMs: 0, error: 'Local-only mode is on, so programs are not started.', hint: 'Turn off local-only mode under Privacy to test this program.' }
    }
    running++
    try {
      if (peer.kind === 'model') {
        const run = await ctx.chat.askModelPeer(peer, { system: consultProtocol(false), history: [], message: PEER_TEST_MESSAGE }, undefined, AbortSignal.timeout(TEST_TIMEOUT_MS))
        return toResult(run)
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
