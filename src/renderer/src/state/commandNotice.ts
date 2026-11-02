import { create } from 'zustand'

/**
 * What a command typed in the composer could not do, shown above the composer until the person changes the message,
 * dismisses it or moves to another task. It is not a turn error: nothing about the task has failed, so it must never
 * look like one to the code that decides what a failed turn means, the message queue and a goal.
 */
interface CommandNoticeState {
  /** Per task. The key for a new session, which has no task yet, is the empty string. */
  notices: Record<string, string>
  show: (conversationId: string | undefined, message: string) => void
  clear: (conversationId: string | undefined) => void
}

const keyOf = (conversationId: string | undefined): string => conversationId ?? ''

export const useCommandNotice = create<CommandNoticeState>((set) => ({
  notices: {},
  show: (conversationId, message) => set((state) => ({ notices: { ...state.notices, [keyOf(conversationId)]: message } })),
  clear: (conversationId) => set((state) => {
    const key = keyOf(conversationId)
    if (!(key in state.notices)) return state
    const { [key]: _gone, ...rest } = state.notices
    return { notices: rest }
  })
}))
