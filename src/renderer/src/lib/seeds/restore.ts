import type { NormalizedAIErrorData } from '@core/types'
import type { RestoreAxes, RestorePreview, RestoreResult } from '../../../../shared/ipc'
import type { LiveMessage } from '../../state/store'
import { QUEUE_LIMIT } from '../messageQueue'
import { HISTORY_STORAGE_KEY, recordPrompt } from '../promptHistory'
import type { PreviewSeed } from './index'

/**
 * Restore, the message queue and prompt history for the browser preview. Every flag rides on one that opens a
 * session, because only those start the seeding (`done` or `thread`).
 *
 *   ?seed=1&done=1&restore=1            three exchanges, each with its own file changes, and stubs for restoring them
 *     restore=fail                      a restore that main refuses
 *     restore=partial                   a file that cannot be written, so the conversation is kept
 *     restore=nocheckpoint              file checkpoints gone after a restart
 *     restore=checkfail                 the file check itself fails
 *     restore=undofail                  an undo that main refuses
 *   ?seed=1&thread=1&queue=1            a turn that is running, with two messages waiting
 *     queue=N                           N messages waiting, from 2 up to the queue limit; queue=single is one
 *     queuehold=answer|failed|stopped   the turn is waiting for an answer (use thread=1), failed, or was stopped;
 *                                       queuehold=1 is a stopped turn, and without queue it brings the two messages
 *   ?seed=1&done=1&history=1            eight earlier prompts, so Up Arrow has something to recall
 */

const SEED_WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const CONVERSATION = 'c1'
const MINUTE = 60_000

/** A prompt history key the way lib/promptHistory.ts files a project: lower case, forward slashes. */
const SEED_PROJECT_KEY = SEED_WORKSPACE.toLowerCase().replace(/\\/g, '/')

const PROMPTS = [
  'Where would a retry go in the upload client?',
  'Keep it small, add no dependencies, and put tests next to the code.',
  'Uploads drop files when the API answers 429. Add retry with exponential backoff, respect Retry-After, and cover it with tests.',
  'Cap the wait at 8 seconds and add jitter.',
  'Also log each retry at debug level.',
  'Run the whole suite, not just the upload tests.',
  'Summarize what changed for the pull request description.',
  'Rename withBackoff to retryWithBackoff everywhere.'
]

const QUEUED = [
  'Update the README with the new retry behavior',
  'Then run the full test suite and fix anything that breaks',
  'Add a changelog entry under Unreleased',
  'Check that the 429 path is covered in the integration tests too, including the case where Retry-After is an HTTP date and not a number of seconds',
  'Open a draft pull request when everything passes'
]

const NOTES = { type: 'file' as const, filename: 'retry-notes.md', source: { kind: 'base64' as const, mediaType: 'text/markdown', data: 'IyBSZXRyeSBub3Rlcw==' } }

const reply = (id: string, text: string, createdAt: number): LiveMessage => ({ id, role: 'assistant', text, createdAt, blocks: [{ type: 'text', text }] })

/** Three finished exchanges, oldest first, so Restore has real choices and each one removes a different amount. */
function restoreThread(now: number): LiveMessage[] {
  return [
    { id: 'u1', role: 'user', text: 'Uploads drop files when the API answers 429. Add retry with exponential backoff, respect Retry-After, and cover it with tests.', createdAt: now - 9 * MINUTE },
    reply('a1', 'I added `withBackoff` in `src/upload/backoff.ts` and used it in `uploadChunk`. A **429** or **5xx** now retries up to four times, and `Retry-After` is honored when the server sends it. The five upload tests pass.', now - 8 * MINUTE),
    { id: 'u2', role: 'user', text: 'Cap the wait at 8 seconds and add jitter.', createdAt: now - 5 * MINUTE },
    reply('a2', 'The delay is now `min(8 s, base * 2^n)` with up to 20% jitter, and a new test covers the cap.', now - 4 * MINUTE),
    { id: 'u3', role: 'user', text: 'Also log each retry at debug level.', createdAt: now - 2 * MINUTE },
    reply('a3', 'Each retry now logs the attempt number and the wait at debug level. Nothing is logged for the first attempt.', now - MINUTE)
  ]
}

/** What each message's turn and the later ones changed, as the file check reports it. */
const PREVIEWS: Record<string, RestorePreview> = {
  u1: {
    checkpoint: true,
    files: [
      { path: 'src/upload/backoff.ts', action: 'delete' },
      { path: 'src/upload/client.ts', action: 'revert' },
      { path: 'src/upload/client.test.ts', action: 'revert' }
    ],
    blocked: [{ path: 'src/upload/config.ts', reason: 'Changed outside Cubex since its last edit' }]
  },
  u2: { checkpoint: true, files: [{ path: 'src/upload/backoff.ts', action: 'revert' }, { path: 'src/upload/client.test.ts', action: 'revert' }], blocked: [] },
  u3: { checkpoint: true, files: [{ path: 'src/upload/client.ts', action: 'revert' }], blocked: [] }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function restoreApi(mode: string) {
  /** The thread as the store has it now, for the counts a real restore would report. */
  const thread = async (messageId: string): Promise<{ removed: number; planIds: string[] }> => {
    const { useStore } = await import('../../state/store')
    const state = useStore.getState()
    const index = state.liveMessages.findIndex((message) => message.id === messageId)
    const since = state.liveMessages[index]?.createdAt ?? Infinity
    return { removed: index < 0 ? 0 : state.liveMessages.length - index, planIds: state.plans.filter((plan) => (plan.createdAt ?? 0) >= since).map((plan) => plan.id) }
  }
  /** What the last restore changed, which is what an undo gives back. */
  let lastRestore = { restored: [] as string[], conversation: false }
  return {
    previewRestore: async (_conversationId: string, messageId: string): Promise<RestorePreview> => {
      await wait(280)
      if (mode === 'checkfail') throw new Error('The file checkpoints could not be read.')
      const preview = PREVIEWS[messageId] ?? { checkpoint: true, files: [], blocked: [] }
      return mode === 'nocheckpoint' ? { checkpoint: false, files: [], blocked: [] } : preview
    },
    restoreCheckpoint: async (_conversationId: string, messageId: string, axes: RestoreAxes): Promise<RestoreResult> => {
      await wait(500)
      if (mode === 'fail') throw new Error('Stop the running turn before restoring an earlier point.')
      const preview = PREVIEWS[messageId] ?? { checkpoint: true, files: [], blocked: [] }
      const { removed, planIds } = await thread(messageId)
      const files = axes.code ? preview.files.map((file) => file.path) : []
      const failed = axes.code && mode === 'partial' ? [{ path: files.at(-1) ?? 'src/upload/client.ts', reason: 'Another program is using it' }] : []
      const restored = files.filter((path) => !failed.some((entry) => entry.path === path))
      // A file that could not be written keeps the conversation whole, the way main does.
      const conversation = axes.conversation && failed.length === 0
      lastRestore = { restored, conversation }
      return {
        restored,
        skipped: axes.code ? preview.blocked : [],
        failed,
        ...(conversation ? { conversation: { removedMessages: removed, removedPlanIds: planIds, contextCleared: false } } : {}),
        ...(restored.length || conversation ? { undoId: 'undo-seed' } : {})
      }
    },
    undoRestore: async (): Promise<{ restored: string[]; conversation: boolean }> => {
      await wait(400)
      if (mode === 'undofail') throw new Error('Undo stopped: these files changed after the restore. Your current files were preserved.\nsrc/upload/client.ts')
      return { restored: [...lastRestore.restored], conversation: lastRestore.conversation }
    }
  }
}

/** Queue the first `count` sample messages once the store has been seeded. */
async function queueMessages(count: number): Promise<void> {
  const { useQueue } = await import('../../state/queue')
  for (let index = 0; index < count; index++) {
    const text = QUEUED[index] ?? `Follow-up ${index + 1}: check the edge case where the server answers 429 twice in a row`
    useQueue.getState().add(CONVERSATION, { text, attachments: index === 1 ? [NOTES] : [] })
  }
}

/** A turn that is not running any more, failed or stopped, so a queue behind it is on hold. */
function endedTurn(messages: LiveMessage[], how: 'failed' | 'stopped'): Record<string, unknown> {
  const last = messages.at(-1)
  const failure: NormalizedAIErrorData = { provider: 'anthropic', category: 'NETWORK_ERROR', message: 'The connection dropped while the answer was streaming.', classification: 'transient', retryable: true }
  return {
    liveMessages: how === 'failed' && last ? [...messages.slice(0, -1), { ...last, error: failure }] : messages,
    status: how === 'failed' ? 'error' : 'cancelled',
    statusDetail: undefined,
    pendingPermission: undefined,
    streamId: undefined
  }
}

/** The preview story's thread, ended. The story lives in previewSeed, which imports this folder, so it is loaded when needed. */
async function endStoryTurn(how: 'failed' | 'stopped'): Promise<void> {
  const [{ useStore }, { seedStory }] = await Promise.all([import('../../state/store'), import('../previewSeed')])
  useStore.setState(endedTurn(seedStory(true), how))
}

/** Seeding can run more than once in development (React runs effects twice), and queued messages and history entries would double. */
let seeded = false

type Hold = 'answer' | 'failed' | 'stopped'

/** How many messages wait: `queue=1` is the usual two, a larger number is that many, `single` is one. */
function waitingCount(flags: URLSearchParams): number {
  const value = flags.get('queue')
  if (value === null) return flags.has('queuehold') ? 2 : 0
  if (value === 'single') return 1
  if (value === '0') return 0
  const count = Math.floor(Number(value))
  return count >= 2 ? Math.min(count, QUEUE_LIMIT) : 2
}

/** Why the queue is on hold, when it is: any value but answer or failed means the turn was stopped. */
function holdOf(flags: URLSearchParams): Hold | undefined {
  const value = flags.get('queuehold')
  if (value === null) return undefined
  return value === 'answer' || value === 'failed' ? value : 'stopped'
}

export const seed: PreviewSeed = {
  state: (flags) => {
    const state: Record<string, unknown> = {}
    const now = Date.now()
    if (flags.has('restore')) Object.assign(state, { liveMessages: restoreThread(now), todos: [], status: 'idle' })
    const queued = waitingCount(flags)
    const hold = holdOf(flags)
    if (!seeded) {
      seeded = true
      if (flags.has('history')) {
        for (const prompt of PROMPTS) recordPrompt(window.localStorage, SEED_PROJECT_KEY, prompt)
        // The composer may have loaded this project's history already; tell it the way another window would.
        window.dispatchEvent(new StorageEvent('storage', { key: HISTORY_STORAGE_KEY }))
      }
      if (queued > 0) {
        // With `restore` the thread is the restore one and is ended below; otherwise the story's thread is.
        if ((hold === 'failed' || hold === 'stopped') && !flags.has('restore')) void endStoryTurn(hold)
        void queueMessages(queued)
      }
    }
    if (queued > 0) {
      if (!hold) {
        // A turn that is running.
        Object.assign(state, { status: 'running_tool', statusDetail: undefined, pendingPermission: undefined, genStartedAt: now - 42_000 })
      } else if (hold === 'answer') {
        // A turn that is waiting for a person; the thread's own permission card, when it has one, is the question.
        Object.assign(state, { status: 'awaiting_input' })
      } else if (flags.has('restore')) {
        Object.assign(state, endedTurn(restoreThread(now), hold))
      }
      Object.assign(state, { streamId: hold === 'failed' || hold === 'stopped' ? undefined : 'seed-stream' })
    }
    return Object.keys(state).length ? state : undefined
  },
  api: (flags) => (flags.has('restore') ? restoreApi(flags.get('restore') ?? '') : {})
}
