import { useCallback, useRef, useState } from 'react'
import type { ReviewFile, ReviewHunk, SessionFileChange } from '../../../shared/ipc'
import { useStore } from '../state/store'
import { lastUserMessageId, useReviewSession, type UndoneHunk } from '../state/reviewSession'
import { api } from './api'
import { splitPath } from './format'
import { undoneText } from './hunkReview'
import type { ReviewData } from './useReview'
import type { Reviewed, SessionChanges } from './useSessionChanges'

/** What the buttons on a hunk do. They talk to the main process, so the tab that owns the review supplies them. */
export interface HunkHandlers {
  keep: (file: ReviewFile, hunks: readonly ReviewHunk[]) => void
  undo: (file: ReviewFile, hunk: ReviewHunk) => void
  restore: (entry: UndoneHunk) => void
  refresh: () => void
}

/** What the Changes tab tells the person about something that just happened to their files. */
export interface Notice {
  tone: 'ok' | 'warn' | 'error'
  text: string
  details?: string[]
  /** The way back from an undo, offered until the person sends their next message. */
  undo?: { revertId: string; label: string; userMessageId: string | undefined }
}

/** The most files `markReviewed` takes in one call. */
const MARK_BATCH = 200

const messageOf = (cause: unknown, fallback: string): string => (cause instanceof Error && cause.message ? cause.message : fallback)
const pendingOf = (file: ReviewFile): ReviewHunk[] => file.hunks.filter((hunk) => hunk.state === 'pending')

interface Options {
  conversationId: string | undefined
  review: ReviewData
  changes: SessionChanges
  reviewed: Reviewed
  files: readonly SessionFileChange[]
  notify: (notice: Notice) => void
}

export interface HunkActions {
  /** A change to the review is being made; the next waits for it. */
  busy: boolean
  handlers: HunkHandlers
  /** Keep every hunk of one file. */
  keepFile: (path: string) => Promise<void>
  /** Keep every hunk of every file. */
  keepAll: () => Promise<void>
  /** Take back an undo, from the notice that offered it. */
  restoreRevert: (revertId: string) => Promise<void>
}

/** Keep, undo and bring back hunks: each calls the main process, then reads the review again so the panel shows what is true. */
export function useHunkActions({ conversationId, review, changes, reviewed, files, notify }: Options): HunkActions {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const recordUndone = useReviewSession((state) => state.recordUndone)
  const forgetUndone = useReviewSession((state) => state.forgetUndone)
  const markStale = useReviewSession((state) => state.markStale)
  const clearStale = useReviewSession((state) => state.clearStale)

  /** One change at a time: each is made against the file as the one before left it. */
  const exclusive = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      lock.current = false
      setBusy(false)
    }
  }, [])

  const settle = useCallback(async (): Promise<void> => {
    await review.refresh()
    changes.refresh()
  }, [review, changes])

  const mark = useCallback(async (targets: ReadonlyArray<{ file: ReviewFile; hunks: readonly ReviewHunk[] }>): Promise<void> => {
    if (!conversationId) return
    const items = targets.flatMap(({ file, hunks }) => {
      const ids = hunks.filter((hunk) => hunk.state === 'pending').map((hunk) => hunk.id)
      return file.headHash && ids.length ? [{ path: file.path, hunkIds: ids, headHash: file.headHash }] : []
    })
    if (!items.length) return
    const kept = new Set(items.flatMap((item) => item.hunkIds))
    // Show the hunks as kept at once; the answer that follows replaces this if the main process saw it differently.
    review.patch((all) => all.map((file) => ({ ...file, hunks: file.hunks.map((hunk) => (kept.has(hunk.id) ? { ...hunk, state: 'accepted' as const } : hunk)) })))
    try {
      for (let at = 0; at < items.length; at += MARK_BATCH) await api.markReviewed(conversationId, items.slice(at, at + MARK_BATCH))
    } catch (cause) {
      notify({ tone: 'error', text: messageOf(cause, 'The change could not be kept.') })
    }
    await settle()
  }, [conversationId, review, settle, notify])

  const keep = useCallback((file: ReviewFile, hunks: readonly ReviewHunk[]): void => {
    void exclusive(async () => {
      await mark([{ file, hunks }])
      // A file whose every hunk is kept counts as reviewed, for the checkbox and for what a commit starts with.
      const left = pendingOf(file).filter((hunk) => !hunks.some((kept) => kept.id === hunk.id))
      const row = files.find((entry) => entry.path === file.path)
      if (!left.length && row) reviewed.markAll([row])
    })
  }, [exclusive, mark, files, reviewed])

  const undo = useCallback((file: ReviewFile, hunk: ReviewHunk): void => {
    if (!conversationId) return
    void exclusive(async () => {
      const { name } = splitPath(file.path)
      try {
        const result = await api.revertHunks(conversationId, { path: file.path, hunkIds: [hunk.id], expectHeadHash: file.headHash ?? '' })
        if (result.conflicts.length) {
          markStale(conversationId, file.path, result.newHeadHash, result.conflicts)
          notify({ tone: 'warn', text: `Nothing was undone in ${name}, and the file was not touched.` })
        } else if (result.applied.length && result.revertId) {
          const applied = file.hunks.filter((entry) => result.applied.includes(entry.id))
          const userMessageId = lastUserMessageId(useStore.getState().liveMessages)
          recordUndone(conversationId, userMessageId, applied.map((entry) => ({ revertId: result.revertId!, path: file.path, hunk: entry, afterHash: result.newHeadHash })))
          notify({
            tone: result.fuzzy?.length ? 'warn' : 'ok',
            text: result.fuzzy?.length
              ? `${undoneText(file, applied)} The file had changed since it was read, so the lines were matched by what surrounds them. Check the result.`
              : undoneText(file, applied),
            undo: { revertId: result.revertId, label: 'Bring it back', userMessageId }
          })
        }
      } catch (cause) {
        notify({ tone: 'error', text: messageOf(cause, 'The change could not be undone.') })
      }
      await settle()
    })
  }, [conversationId, exclusive, markStale, recordUndone, settle, notify])

  const restoreRevert = useCallback(async (revertId: string): Promise<void> => {
    if (!conversationId) return
    await exclusive(async () => {
      try {
        const { restored } = await api.undoRevert(conversationId, revertId)
        forgetUndone(conversationId, revertId)
        notify({
          tone: 'ok',
          text: restored.length === 1 ? `Brought back the change to ${splitPath(restored[0]!).name}.` : `Brought back the changes to ${restored.length} files.`
        })
      } catch (cause) {
        notify({ tone: 'error', text: messageOf(cause, 'The change could not be brought back.') })
      }
      await settle()
    })
  }, [conversationId, exclusive, forgetUndone, notify, settle])

  const refresh = useCallback((): void => {
    void (async () => {
      await settle()
      if (conversationId) for (const file of review.files) clearStale(conversationId, file.path)
    })()
  }, [conversationId, review, settle, clearStale])

  const keepFile = useCallback(async (path: string): Promise<void> => {
    const file = review.files.find((entry) => entry.path === path)
    if (file) await exclusive(() => mark([{ file, hunks: file.hunks }]))
  }, [review, exclusive, mark])

  const keepAll = useCallback(async (): Promise<void> => {
    await exclusive(() => mark(review.files.map((file) => ({ file, hunks: file.hunks }))))
  }, [review, exclusive, mark])

  const restore = useCallback((entry: UndoneHunk): void => { void restoreRevert(entry.revertId) }, [restoreRevert])

  return { busy, handlers: { keep, undo, restore, refresh }, keepFile, keepAll, restoreRevert }
}
