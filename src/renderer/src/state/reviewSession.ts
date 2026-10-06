import { useMemo } from 'react'
import { create } from 'zustand'
import type { ReviewComment, ReviewHunk } from '../../../shared/ipc'
import { useStore, type LiveMessage } from './store'

/** A hunk the person undid in this conversation, kept to show it where it was and to bring it back. */
export interface UndoneHunk {
  revertId: string
  path: string
  hunk: ReviewHunk
  /** The file's hash right after the undo: bringing the hunk back works only while the file still has it. */
  afterHash: string | null
}

/** A hunk whose undo was refused because the file no longer matches it. */
export interface StaleMark {
  reason: 'drift' | 'context_mismatch'
  /** The file's hash when it was refused; a different hash means the file was read again since. */
  headHash: string | null
}

/** A comment being written, with the words so far. Kept here so that looking at another file does not lose them. */
export interface CommentDraft extends Pick<ReviewComment, 'path' | 'startLine' | 'endLine' | 'side'> {
  /** One per place: opening the same place again finds the one already open. */
  id: string
  hunkId: string
  text: string
  /** The queued comment this changes; absent for a new one. */
  editing?: string
}

interface Session {
  /** The last message the person had sent when these were undone: sending another ends the window to bring them back. */
  userMessageId?: string
  undone: readonly UndoneHunk[]
  stale: Readonly<Record<string, StaleMark>>
  drafts: readonly CommentDraft[]
}

/** Enough to show every hunk of a big review undone, and no more. */
const MAX_UNDONE = 60

const EMPTY: Session = { undone: [], stale: {}, drafts: [] }
const NONE: readonly UndoneHunk[] = []
const NO_DRAFTS: readonly CommentDraft[] = []

export const staleKey = (path: string, hunkId: string): string => `${path}\n${hunkId}`

/** The id of the last message the person sent: undoing is possible until it changes. */
export function lastUserMessageId(messages: readonly Pick<LiveMessage, 'id' | 'role'>[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === 'user') return messages[index]!.id
  }
  return undefined
}

interface SessionState {
  sessions: Record<string, Session>
  /** Remember hunks that were just undone. Hunks undone before the person's last message can no longer be brought back, so they go. */
  recordUndone: (conversationId: string, userMessageId: string | undefined, entries: readonly UndoneHunk[]) => void
  /** Forget the hunks of one undo, after it was undone or can no longer be. */
  forgetUndone: (conversationId: string, revertId: string) => void
  /** Remember hunks that could not be undone because their file has changed. */
  markStale: (conversationId: string, path: string, headHash: string | null, conflicts: ReadonlyArray<{ hunkId: string; reason: StaleMark['reason'] }>) => void
  /** Forget what was refused for a file, after its hunks were read again. */
  clearStale: (conversationId: string, path: string) => void
  /** Open an editor for a comment, unless one is already open for that place. */
  openDraft: (conversationId: string, draft: CommentDraft) => void
  setDraftText: (conversationId: string, id: string, text: string) => void
  closeDraft: (conversationId: string, id: string) => void
}

/** What the review panel remembers about a conversation between visits to the tab. In memory only: it is about the moment. */
export const useReviewSession = create<SessionState>((set) => {
  const update = (conversationId: string, change: (session: Session) => Session): void =>
    set((state) => ({ sessions: { ...state.sessions, [conversationId]: change(state.sessions[conversationId] ?? EMPTY) } }))
  return {
    sessions: {},
    recordUndone: (conversationId, userMessageId, entries) => update(conversationId, (session) => ({
      ...session,
      userMessageId,
      undone: [...(session.userMessageId === userMessageId ? session.undone : []), ...entries].slice(-MAX_UNDONE)
    })),
    forgetUndone: (conversationId, revertId) => update(conversationId, (session) => ({
      ...session,
      undone: session.undone.filter((entry) => entry.revertId !== revertId)
    })),
    markStale: (conversationId, path, headHash, conflicts) => update(conversationId, (session) => ({
      ...session,
      stale: { ...session.stale, ...Object.fromEntries(conflicts.map((conflict) => [staleKey(path, conflict.hunkId), { reason: conflict.reason, headHash }])) }
    })),
    clearStale: (conversationId, path) => update(conversationId, (session) => ({
      ...session,
      stale: Object.fromEntries(Object.entries(session.stale).filter(([key]) => !key.startsWith(`${path}\n`)))
    })),
    openDraft: (conversationId, draft) => update(conversationId, (session) => (
      session.drafts.some((open) => open.id === draft.id) ? session : { ...session, drafts: [...session.drafts, draft] }
    )),
    setDraftText: (conversationId, id, text) => update(conversationId, (session) => ({
      ...session,
      drafts: session.drafts.map((draft) => (draft.id === id ? { ...draft, text } : draft))
    })),
    closeDraft: (conversationId, id) => update(conversationId, (session) => ({
      ...session,
      drafts: session.drafts.filter((draft) => draft.id !== id)
    }))
  }
})

/** The hunks undone in a conversation that can still be brought back, in the order they were undone. */
export function useUndoneHunks(conversationId: string | undefined): readonly UndoneHunk[] {
  const lastMessage = useStore((state) => lastUserMessageId(state.liveMessages))
  const session = useReviewSession((state) => (conversationId ? state.sessions[conversationId] : undefined))
  return useMemo(() => (session && session.userMessageId === lastMessage ? session.undone : NONE), [session, lastMessage])
}

/** The hunks of a conversation whose undo was refused, by `staleKey`. */
export function useStaleMarks(conversationId: string | undefined): Readonly<Record<string, StaleMark>> {
  return useReviewSession((state) => (conversationId ? state.sessions[conversationId]?.stale : undefined)) ?? EMPTY.stale
}

/** The comments being written in a conversation. */
export function useCommentDrafts(conversationId: string | undefined): readonly CommentDraft[] {
  return useReviewSession((state) => (conversationId ? state.sessions[conversationId]?.drafts : undefined)) ?? NO_DRAFTS
}
