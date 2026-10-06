import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { nanoid } from 'nanoid'
import type { MessageContentPart } from '@core/types'
import { api } from '../lib/api'
import {
  enqueue,
  pruneQueues,
  putBack,
  queueGate,
  take,
  turnEndFor,
  type QueueConditions,
  type QueueGate,
  type QueuedMessage
} from '../lib/messageQueue'
import { selectableProvider, useStore } from './store'

type StoreState = ReturnType<typeof useStore.getState>

interface QueueState {
  /** Messages typed while a turn ran, per task. They live for the app run and are gone after a restart. */
  queues: Record<string, QueuedMessage[]>
  /** Queue a message for a task. False when it is empty or the queue is full. */
  add: (conversationId: string, input: { text: string; attachments: MessageContentPart[] }) => boolean
  remove: (conversationId: string, id: string) => void
  /** Stop the running turn, if any, and send this message now. */
  sendNow: (conversationId: string, id: string) => Promise<void>
}

/** The queues with one task's list replaced; a task with nothing queued has no entry. */
function withQueue(queues: Record<string, QueuedMessage[]>, conversationId: string, queue: QueuedMessage[]): Record<string, QueuedMessage[]> {
  const next = { ...queues }
  if (queue.length) next[conversationId] = queue
  else delete next[conversationId]
  return next
}

/** A task's own run state: the visible one is the store itself, a background one is cached beside it. */
function runOf(state: StoreState, conversationId: string): StoreState {
  return state.activeConversation?.id === conversationId ? state : { ...state, ...state.conversationRuns[conversationId] }
}

/** What decides whether a task's queue may send, read from the store. */
export function conditionsFor(state: StoreState, conversationId: string): QueueConditions {
  const run = runOf(state, conversationId)
  const provider = state.providers.find((candidate) => candidate.id === state.activeProviderId)
  return {
    running: !!run.streamId || run.startingRequest || run.liveMessages.some((message) => message.streaming),
    compacting: state.compactingId === conversationId,
    needsAnswer: !!run.pendingPermission || !!run.pendingQuestion || !!run.pendingPlan || run.status === 'awaiting_input',
    modelReady: !!state.activeModel && !!provider && selectableProvider(provider, state.settings),
    lastEnd: turnEndFor(run.status),
    viewing: state.activeConversation?.id === conversationId
  }
}

const IDLE: QueueConditions = { running: false, compacting: false, needsAnswer: false, modelReady: true, lastEnd: undefined, viewing: true }

/** The gate of a task's queue, for display. Compared shallowly, so streaming text does not re-render the queue. */
export function useQueueGate(conversationId: string | undefined): QueueGate {
  return queueGate(useStore(useShallow((state) => (conversationId ? conditionsFor(state, conversationId) : IDLE))))
}

export const useQueue = create<QueueState>((set, get) => ({
  queues: {},
  add: (conversationId, input) => {
    const item: QueuedMessage = { id: nanoid(), text: input.text.trim(), attachments: input.attachments, queuedAt: Date.now() }
    const result = enqueue(get().queues[conversationId] ?? [], item)
    if (!result.accepted) return false
    set((state) => ({ queues: withQueue(state.queues, conversationId, result.queue) }))
    installRunner()
    return true
  },
  remove: (conversationId, id) => { pull(conversationId, id) },
  sendNow: async (conversationId, id) => {
    // A summary being written cannot be interrupted, so the message keeps its place until it is done.
    if (conditionsFor(useStore.getState(), conversationId).compacting) return
    const item = pull(conversationId, id)
    if (!item) return
    if (useStore.getState().activeConversation?.id !== conversationId) {
      restore(conversationId, item)
      return
    }
    // The running turn ends first, or main would refuse a second turn on the same task.
    await settleStart()
    const { streamId } = useStore.getState()
    if (streamId || conditionsFor(useStore.getState(), conversationId).running) {
      const ended = streamId ? waitForStreamEnd(streamId) : Promise.resolve()
      useStore.getState().cancel()
      await ended
    }
    if (!(await dispatch(item))) restore(conversationId, item)
  }
}))

/** Take one message out of a task's queue and hand it back. */
function pull(conversationId: string, id: string): QueuedMessage | undefined {
  const { item, queue } = take(useQueue.getState().queues[conversationId] ?? [], id)
  if (item) useQueue.setState((state) => ({ queues: withQueue(state.queues, conversationId, queue) }))
  return item
}

function restore(conversationId: string, item: QueuedMessage): void {
  useQueue.setState((state) => ({ queues: withQueue(state.queues, conversationId, putBack(state.queues[conversationId] ?? [], item)) }))
}

/** Bring a queued message back into the composer to change it. Whatever is being typed stays, above it. */
export function pullIntoComposer(conversationId: string, id: string): boolean {
  const item = pull(conversationId, id)
  if (!item) return false
  const store = useStore.getState()
  const draft = store.composerText.replace(/\s+$/, '')
  store.setComposerText(draft ? `${draft}\n\n${item.text}` : item.text)
  for (const part of item.attachments) store.addAttachment(part)
  return true
}

/** What typing the message and pressing Enter would have done: a command runs, anything else is sent. */
async function dispatch(item: QueuedMessage): Promise<boolean> {
  if (item.text.startsWith('/')) {
    try {
      if (await useStore.getState().runSlashCommand(item.text)) return true
    } catch (cause) {
      useStore.setState({ status: 'error', statusDetail: cause instanceof Error ? cause.message : 'The command could not be completed.' })
      return true
    }
  }
  return useStore.getState().sendMessage(item.text, { attachments: item.attachments })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A request is still being handed to main; a stream id exists once that is done. */
async function settleStart(): Promise<void> {
  for (let waited = 0; useStore.getState().startingRequest && waited < 2000; waited += 40) await sleep(40)
}

/**
 * Resolves when main has retired a stream. Main emits the final event just before it frees the task, and the
 * store stops listening to a stream the moment it is cancelled, so this listens on its own.
 */
function waitForStreamEnd(streamId: string, timeoutMs = 2500): Promise<void> {
  return new Promise((resolve) => {
    let stopListening: () => void = () => undefined
    const finish = (): void => {
      clearTimeout(timer)
      stopListening()
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    stopListening = api.onChatEvent((event) => {
      if (event.streamId === streamId && event.kind === 'stream' && (event.event.type === 'completed' || event.event.type === 'error')) finish()
    })
  })
}

// --- The runner: sends the next message when the visible task's turn ends normally. -----------------------------

let runnerInstalled = false
let scheduled = false
const dispatching = new Set<string>()
/** After a send that did not go out, wait before trying again so a persistent refusal cannot spin. */
const retryAfter = new Map<string, number>()
const RETRY_DELAY_MS = 1000

function installRunner(): void {
  if (runnerInstalled) return
  runnerInstalled = true
  useStore.subscribe(schedule)
  useQueue.subscribe(schedule)
}

/** Look again once the current update has settled, never in the middle of an event handler. */
function schedule(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    void evaluate()
  })
}

async function evaluate(): Promise<void> {
  const queues = useQueue.getState().queues
  if (Object.keys(queues).length === 0) return
  const state = useStore.getState()

  // A task that was deleted takes its queue with it.
  const known = new Set([...state.conversations.map((entry) => entry.id), ...Object.keys(state.conversationRuns)])
  if (state.activeConversation) known.add(state.activeConversation.id)
  const kept = pruneQueues(queues, known)
  if (Object.keys(kept).length !== Object.keys(queues).length) useQueue.setState({ queues: kept })

  const conversationId = state.activeConversation?.id
  if (!conversationId || dispatching.has(conversationId) || Date.now() < (retryAfter.get(conversationId) ?? 0)) return
  const first = kept[conversationId]?.[0]
  if (!first || queueGate(conditionsFor(state, conversationId)).action !== 'send') return

  dispatching.add(conversationId)
  pull(conversationId, first.id)
  let sent = false
  try {
    sent = await dispatch(first)
  } catch {
    sent = false
  } finally {
    dispatching.delete(conversationId)
    if (!sent) {
      restore(conversationId, first)
      retryAfter.set(conversationId, Date.now() + RETRY_DELAY_MS)
      setTimeout(schedule, RETRY_DELAY_MS)
    }
  }
}
