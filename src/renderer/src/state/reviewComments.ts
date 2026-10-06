import { useEffect } from 'react'
import { create } from 'zustand'
import type { ReviewComment } from '../../../shared/ipc'

/** A comment waiting to be sent, with what the tray needs to show it once its hunk is gone. */
export interface QueuedComment extends ReviewComment {
  createdAt: number
  /** The first changed line it is about, trimmed. */
  excerpt?: string
}

/** What the main process accepts in one message. */
export const MAX_QUEUED_COMMENTS = 50
export const COMMENT_MAX_LENGTH = 4000

const NONE: readonly QueuedComment[] = []

const storageKey = (conversationId: string): string => `cubex.reviewComments.${conversationId}`

function isQueued(value: unknown): value is QueuedComment {
  const comment = value as Partial<QueuedComment> | null
  return !!comment && typeof comment.id === 'string' && typeof comment.path === 'string' && typeof comment.text === 'string' &&
    Number.isSafeInteger(comment.startLine) && Number.isSafeInteger(comment.endLine) && (comment.side === 'old' || comment.side === 'new') &&
    (comment.hunkId === undefined || typeof comment.hunkId === 'string') && Number.isFinite(comment.createdAt)
}

/** What was saved for a conversation: only well-formed comments, never more than a message can hold. */
export function loadQueued(conversationId: string): QueuedComment[] {
  try {
    const raw = localStorage.getItem(storageKey(conversationId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(isQueued).map((comment) => ({ ...comment, text: comment.text.slice(0, COMMENT_MAX_LENGTH) })).slice(0, MAX_QUEUED_COMMENTS)
      : []
  } catch {
    return []
  }
}

function saveQueued(conversationId: string, comments: readonly QueuedComment[]): void {
  try {
    if (comments.length) localStorage.setItem(storageKey(conversationId), JSON.stringify(comments))
    else localStorage.removeItem(storageKey(conversationId))
  } catch { /* the comments just will not survive a restart */ }
}

interface QueueState {
  byConversation: Record<string, readonly QueuedComment[]>
  /** Read what was saved for a conversation, once. */
  hydrate: (conversationId: string) => void
  /** Queue a comment; false when the conversation already holds as many as one message can carry. */
  add: (conversationId: string, comment: QueuedComment) => boolean
  edit: (conversationId: string, id: string, text: string) => void
  remove: (conversationId: string, ids: readonly string[]) => void
}

/** The review comments each conversation has queued for its next message to Cubex. They live until sent or removed. */
export const useReviewComments = create<QueueState>((set, get) => {
  const update = (conversationId: string, change: (current: readonly QueuedComment[]) => readonly QueuedComment[]): void => {
    const next = change(get().byConversation[conversationId] ?? loadQueued(conversationId))
    set((state) => ({ byConversation: { ...state.byConversation, [conversationId]: next } }))
    saveQueued(conversationId, next)
  }
  return {
    byConversation: {},
    hydrate: (conversationId) => {
      if (get().byConversation[conversationId]) return
      set((state) => ({ byConversation: { ...state.byConversation, [conversationId]: loadQueued(conversationId) } }))
    },
    add: (conversationId, comment) => {
      const text = comment.text.trim().slice(0, COMMENT_MAX_LENGTH)
      if (!text || (get().byConversation[conversationId] ?? loadQueued(conversationId)).length >= MAX_QUEUED_COMMENTS) return false
      update(conversationId, (current) => [...current, { ...comment, text }])
      return true
    },
    edit: (conversationId, id, text) => {
      const clean = text.trim().slice(0, COMMENT_MAX_LENGTH)
      if (clean) update(conversationId, (current) => current.map((comment) => (comment.id === id ? { ...comment, text: clean } : comment)))
    },
    remove: (conversationId, ids) => update(conversationId, (current) => current.filter((comment) => !ids.includes(comment.id)))
  }
})

/** The comments queued for a conversation, in the order they were written. Reading them the first time loads what was saved. */
export function useQueuedComments(conversationId: string | undefined): readonly QueuedComment[] {
  const hydrate = useReviewComments((state) => state.hydrate)
  useEffect(() => {
    if (conversationId) hydrate(conversationId)
  }, [conversationId, hydrate])
  return useReviewComments((state) => (conversationId ? state.byConversation[conversationId] : undefined) ?? NONE)
}
