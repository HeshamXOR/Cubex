import { create } from 'zustand'
import type { Conversation, RestoreAxes, RestoreResult } from '../../../shared/ipc'
import { api } from '../lib/api'
import { focusComposer } from '../lib/composerFocus'
import { useStore, type LiveMessage } from './store'

type StoreState = ReturnType<typeof useStore.getState>
type ContextCut = Pick<Conversation, 'contextStartMessageId' | 'contextSummary' | 'contextSummaryAt'>

const NO_CUT: ContextCut = { contextStartMessageId: undefined, contextSummary: undefined, contextSummaryAt: undefined }

/** What an undo needs to put the thread back as the restore found it. */
interface Cut {
  messages: LiveMessage[]
  context: ContextCut
  /** What the restore put in the composer, so an undo can take it out again if it is still there. */
  composer?: { text: string; attachments: NonNullable<LiveMessage['attachments']> }
}

export interface RestoreNotice {
  kind: 'restored' | 'undone' | 'failed' | 'undo-failed'
  axes: RestoreAxes
  /** What the restore reports having done. Absent when it failed outright. */
  result?: RestoreResult
  /** Files and messages an undo brought back, for its own sentence. */
  undone?: { files: number; messages: number }
  /** Why it failed, in plain words. The first line is the sentence; later lines are file paths. */
  error?: string
  /** Pass to undo while the thread still ends where the restore left it. */
  undoId?: string
  undoing: boolean
  /** Messages in the thread when this was made. Sending another one ends the chance to undo, and the notice goes with it. */
  messageCount: number
  cut?: Cut
}

interface RestoreState {
  notices: Record<string, RestoreNotice>
  /** A restore or an undo is in flight: the composer waits so nothing is sent into a thread that is being cut. */
  restoring: boolean
  dismiss: (conversationId: string) => void
}

export const useRestore = create<RestoreState>((set) => ({
  notices: {},
  restoring: false,
  dismiss: (conversationId) => set((state) => {
    const notices = { ...state.notices }
    delete notices[conversationId]
    return { notices }
  })
}))

/** A turn is starting or running: history must not be rewritten under it. */
const turnBusy = (state: StoreState): boolean => !!state.streamId || state.startingRequest || state.liveMessages.some((message) => message.streaming)

const reasonOf = (cause: unknown, fallback: string): string => (cause instanceof Error && cause.message.trim() ? cause.message : fallback)

function setNotice(conversationId: string, notice: RestoreNotice): void {
  useRestore.setState((state) => ({ notices: { ...state.notices, [conversationId]: notice } }))
}

const threadLength = (conversationId: string): number => {
  const state = useStore.getState()
  return (state.activeConversation?.id === conversationId ? state : { ...state, ...state.conversationRuns[conversationId] }).liveMessages.length
}

/** Change a task's run state: the visible one is the store itself, a background one is cached beside it. */
function updateRun(conversationId: string, update: (run: StoreState) => Partial<StoreState>): void {
  useStore.setState((state) => {
    if (state.activeConversation?.id === conversationId) return update(state)
    const cached = state.conversationRuns[conversationId]
    if (!cached) return {}
    return { conversationRuns: { ...state.conversationRuns, [conversationId]: { ...cached, ...update({ ...state, ...cached }) } } }
  })
}

/** Cut the thread back to before a message, the way main already cut the saved conversation. */
function cutThread(conversationId: string, messageId: string, removedPlanIds: readonly string[], contextCleared: boolean): Cut | undefined {
  let cut: Cut | undefined
  updateRun(conversationId, (run) => {
    const index = run.liveMessages.findIndex((message) => message.id === messageId)
    if (index < 0) return {}
    const target = run.liveMessages[index]!
    cut = {
      messages: run.liveMessages.slice(index),
      context: {
        contextStartMessageId: run.activeConversation?.contextStartMessageId,
        contextSummary: run.activeConversation?.contextSummary,
        contextSummaryAt: run.activeConversation?.contextSummaryAt
      }
    }
    // The message goes back where it was typed, unless something is already being written there.
    const composerFree = run.composerText.trim() === '' && run.attachments.length === 0
    const attachments = target.attachments ?? []
    if (composerFree) cut.composer = { text: target.text, attachments }
    return {
      liveMessages: run.liveMessages.slice(0, index),
      // The meter and the checklist described the turns that are gone.
      contextUsage: undefined,
      todos: [],
      ...(run.activeConversation && contextCleared ? { activeConversation: { ...run.activeConversation, ...NO_CUT } } : {}),
      ...(composerFree ? { composerText: target.text, composerRevision: run.composerRevision + 1, attachments } : {})
    }
  })
  if (removedPlanIds.length && useStore.getState().activeConversation?.id === conversationId) {
    useStore.setState((state) => {
      const gone = new Set(removedPlanIds)
      const plans = state.plans.filter((plan) => !gone.has(plan.id))
      const activeGone = !!state.activePlan && gone.has(state.activePlan.id)
      return { plans, ...(activeGone ? { activePlan: plans[0], planPanelOpen: state.planPanelOpen && plans.length > 0 } : {}) }
    })
  }
  return cut
}

/** Go back to before a message: its files, its conversation, or both. The thread follows what main saved. */
export async function restoreTo(messageId: string, axes: RestoreAxes): Promise<void> {
  const state = useStore.getState()
  const conversationId = state.activeConversation?.id
  if (!conversationId || useRestore.getState().restoring || turnBusy(state) || !state.liveMessages.some((message) => message.id === messageId)) return
  useRestore.setState({ restoring: true })
  try {
    const result = await api.restoreCheckpoint(conversationId, messageId, axes)
    const cut = result.conversation ? cutThread(conversationId, messageId, result.conversation.removedPlanIds, result.conversation.contextCleared) : undefined
    setNotice(conversationId, { kind: 'restored', axes, result, undoId: result.undoId, undoing: false, messageCount: threadLength(conversationId), ...(cut ? { cut } : {}) })
    if (cut?.composer && useStore.getState().activeConversation?.id === conversationId) focusComposer()
  } catch (cause) {
    setNotice(conversationId, { kind: 'failed', axes, error: reasonOf(cause, 'The restore could not be completed. Nothing was changed.'), undoing: false, messageCount: threadLength(conversationId) })
  } finally {
    useRestore.setState({ restoring: false })
  }
}

/** Undo the last restore of the visible task, while nothing has been sent since. */
export async function undoRestore(): Promise<void> {
  const state = useStore.getState()
  const conversationId = state.activeConversation?.id
  const notice = conversationId ? useRestore.getState().notices[conversationId] : undefined
  if (!conversationId || !notice || notice.kind !== 'restored' || !notice.undoId || notice.undoing || useRestore.getState().restoring || turnBusy(state)) return
  setNotice(conversationId, { ...notice, undoing: true })
  useRestore.setState({ restoring: true })
  try {
    const out = await api.undoRestore(conversationId, notice.undoId)
    const cut = notice.cut
    if (out.conversation && cut) {
      updateRun(conversationId, (run) => {
        const typedStillThere = !!cut.composer && run.composerText === cut.composer.text && run.attachments === cut.composer.attachments
        return {
          liveMessages: [...run.liveMessages, ...cut.messages],
          contextUsage: undefined,
          ...(run.activeConversation ? { activeConversation: { ...run.activeConversation, ...cut.context } } : {}),
          // The message the restore put back in the composer is a duplicate once the thread has it again.
          ...(typedStillThere ? { composerText: '', composerRevision: run.composerRevision + 1, attachments: [] } : {})
        }
      })
      if (useStore.getState().activeConversation?.id === conversationId) void useStore.getState().loadPlans(conversationId)
    }
    setNotice(conversationId, {
      kind: 'undone', axes: notice.axes, undoing: false, messageCount: threadLength(conversationId),
      undone: { files: out.restored.length, messages: out.conversation ? cut?.messages.length ?? 0 : 0 }
    })
  } catch (cause) {
    setNotice(conversationId, { ...notice, kind: 'undo-failed', undoing: false, undoId: undefined, error: reasonOf(cause, 'The restore could not be undone.') })
  } finally {
    useRestore.setState({ restoring: false })
  }
}
