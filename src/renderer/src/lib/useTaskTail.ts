import { useEffect, useState } from 'react'
import type { BackgroundTask, CommandOutputArtifact } from '../../../shared/ipc'
import { api } from './api'
import { advanceTail, type ReadPage, type TailCursor } from './taskTail'

export interface TailView {
  /** The newest output as the process wrote it; clean it for display with tailLines. */
  raw: string
  /** `raw` is the whole output, from its first byte. */
  complete: boolean
  artifact?: CommandOutputArtifact
  error?: string
  /** Nothing has been read yet. */
  loading: boolean
}

/** Cursors outlive the rows that read them, so closing and reopening the tab shows the output at once. */
const CACHE_LIMIT = 32
const cursors = new Map<string, TailCursor>()

function remember(outputId: string, cursor: TailCursor): void {
  cursors.delete(outputId)
  cursors.set(outputId, cursor)
  if (cursors.size > CACHE_LIMIT) cursors.delete(cursors.keys().next().value as string)
}

function viewOf(cursor: TailCursor | undefined): TailView {
  return cursor
    ? { raw: cursor.raw, complete: cursor.complete, artifact: cursor.artifact, loading: false }
    : { raw: '', complete: true, loading: true }
}

/**
 * Follows a task's saved output. A running task is polled every `intervalMs` while the window is
 * visible; one that has ended is read once more so its last lines are not missed.
 */
export function useTaskTail(task: BackgroundTask, intervalMs: number): TailView {
  const { conversationId, outputId } = task
  const live = task.status === 'running'
  const [view, setView] = useState<TailView>(() => viewOf(cursors.get(outputId)))

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    setView(viewOf(cursors.get(outputId)))
    const read: ReadPage = (offset, limit) => api.readCommandOutput(conversationId, outputId, offset, limit)

    const schedule = (): void => {
      if (cancelled || !live) return
      timer = window.setTimeout(() => {
        if (document.hidden) schedule()
        else void step()
      }, intervalMs)
    }
    const step = async (): Promise<void> => {
      try {
        const next = await advanceTail(read, cursors.get(outputId))
        remember(outputId, next)
        if (!cancelled) setView(viewOf(next))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setView((current) => ({ ...current, loading: false, error: message }))
      }
      schedule()
    }
    void step()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [conversationId, outputId, live, intervalMs])

  return view
}
