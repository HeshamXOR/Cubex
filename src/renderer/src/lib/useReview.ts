import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewFile } from '../../../shared/ipc'
import { api } from './api'
import { sameReview } from './hunkReview'

export interface ReviewData {
  files: readonly ReviewFile[]
  /** False until the first answer for this conversation arrives. */
  loaded: boolean
  /** Why the hunks could not be read, when they could not. */
  error?: string
  /** Read the hunks again now; resolves once the answer is in. */
  refresh: () => Promise<void>
  /** Show a change before the answer for it arrives, such as a hunk being kept. The next answer replaces it. */
  patch: (change: (files: readonly ReviewFile[]) => readonly ReviewFile[]) => void
}

interface Answer {
  owner?: string
  files: readonly ReviewFile[]
  error?: string
}

const NONE: readonly ReviewFile[] = []
/** Edits and reverts come in bursts; one read after the last of them is enough. */
const SETTLE_MS = 80

/** The hunks of what a conversation changed, read again whenever the main process says its review changed (`revision`). */
export function useReview(conversationId: string | undefined, revision: number): ReviewData {
  const [answer, setAnswer] = useState<Answer>({ files: NONE })
  const latest = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!conversationId) return
    const mine = ++latest.current
    try {
      const files = await api.getReview(conversationId, { kind: 'session' })
      if (mine !== latest.current) return
      // The same answer again keeps the panel as it is, so a refetch that found nothing new redraws nothing.
      setAnswer((previous) => (previous.owner === conversationId && !previous.error && sameReview(previous.files, files) ? previous : { owner: conversationId, files }))
    } catch (cause) {
      if (mine !== latest.current) return
      setAnswer({ owner: conversationId, files: NONE, error: cause instanceof Error ? cause.message : 'The hunks could not be read.' })
    }
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const timer = window.setTimeout(() => void refresh(), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [conversationId, revision, refresh])

  const patch = useCallback((change: (files: readonly ReviewFile[]) => readonly ReviewFile[]): void => {
    setAnswer((previous) => (previous.owner === conversationId && !previous.error ? { ...previous, files: change(previous.files) } : previous))
  }, [conversationId])

  const current = answer.owner === conversationId
  return {
    files: current ? answer.files : NONE,
    loaded: current,
    ...(current && answer.error ? { error: answer.error } : {}),
    refresh,
    patch
  }
}
