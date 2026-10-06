import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../state/store'
import { activitySpecFor, type HarnessState } from '../status/StatusIndicator'

export type SessionState = 'idle' | 'running' | 'waiting'

interface RunLike {
  status: HarnessState
  pendingPermission?: unknown
  pendingQuestion?: unknown
  pendingPlan?: unknown
}

/** Needs the person beats working; anything else is quiet. */
export function sessionStateOf(run: RunLike | undefined): SessionState {
  if (!run) return 'idle'
  if (run.pendingPermission || run.pendingQuestion || run.pendingPlan || run.status === 'awaiting_input') return 'waiting'
  return activitySpecFor(run.status).active ? 'running' : 'idle'
}

/** What every conversation is doing right now, for the sidebar's status glyphs. */
export function useSessionStates(): Record<string, SessionState> {
  return useStore(useShallow((state) => {
    const states: Record<string, SessionState> = {}
    for (const [id, run] of Object.entries(state.conversationRuns)) states[id] = sessionStateOf(run)
    // The open conversation lives in the top-level fields rather than in its cached run.
    if (state.activeConversation) states[state.activeConversation.id] = sessionStateOf(state)
    return states
  }))
}
