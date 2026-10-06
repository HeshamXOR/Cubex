import { create } from 'zustand'
import type { BackgroundTask } from '../../../shared/ipc'
import { api } from '../lib/api'
import { mergeTasks, runningCount } from '../lib/taskModel'

interface TasksState {
  /** Every background task the window knows of, by conversation. */
  byConversation: Record<string, BackgroundTask[]>
  /** Which rows of the Tasks tab are open; kept here so they stay open while the tab is away. */
  open: Record<string, boolean>
  upsert: (tasks: readonly BackgroundTask[]) => void
  setOpen: (taskId: string, open: boolean) => void
}

/**
 * Background tasks, kept apart from the chat store: they outlive the turn that started them, so they are
 * fed by the main process's own `task` events rather than by a turn's stream.
 */
export const useTasks = create<TasksState>((set) => ({
  byConversation: {},
  open: {},
  upsert: (tasks) => set((state) => {
    const next = { ...state.byConversation }
    for (const task of tasks) next[task.conversationId] = mergeTasks(next[task.conversationId] ?? [], [task])
    return { byConversation: next }
  }),
  setOpen: (taskId, open) => set((state) => ({ open: { ...state.open, [taskId]: open } }))
}))

/** One `task` chat event: the task started or changed state. */
export function applyTaskEvent(task: BackgroundTask): void {
  useTasks.getState().upsert([task])
}

const EMPTY: readonly BackgroundTask[] = []

/** The tasks of one conversation, running first. Stable while nothing about them changes. */
export function useConversationTasks(conversationId: string | undefined): readonly BackgroundTask[] {
  return useTasks((state) => (conversationId ? state.byConversation[conversationId] : undefined) ?? EMPTY)
}

/** How many of a conversation's tasks are running right now. */
export function useRunningCount(conversationId: string | undefined): number {
  return useTasks((state) => runningCount(conversationId ? state.byConversation[conversationId] : undefined))
}

/**
 * Ask the main process for a conversation's tasks. Events keep them current afterwards; this covers
 * what happened while no one was listening (the window reloaded) and is the Tasks tab's fallback poll.
 */
export async function syncTasks(conversationId: string): Promise<void> {
  try {
    useTasks.getState().upsert(await api.listTasks(conversationId))
  } catch {
    // The list is a convenience; the events already received stay as they are.
  }
}
