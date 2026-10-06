import { useCallback, useEffect, useState } from 'react'
import { reviewId } from './useSessionChanges'
import type { SessionFileChange } from '../../../shared/ipc'

function committedKey(conversationId: string): string {
  return `cubex.committed.${conversationId}`
}

function loadCommitted(conversationId: string | undefined): Set<string> {
  if (!conversationId) return new Set()
  try {
    const raw = localStorage.getItem(committedKey(conversationId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

export interface Committed {
  has: (file: SessionFileChange) => boolean
  add: (files: readonly SessionFileChange[]) => void
}

/**
 * Which versions of the changed files were committed from the review panel. A later
 * edit gives a file a new version, so it counts as uncommitted again. Kept per
 * conversation, on this machine only; git status stays the source of truth.
 */
export function useCommitted(conversationId: string | undefined): Committed {
  const [marks, setMarks] = useState(() => loadCommitted(conversationId))
  useEffect(() => setMarks(loadCommitted(conversationId)), [conversationId])

  const has = useCallback((file: SessionFileChange) => marks.has(reviewId(file)), [marks])
  const add = useCallback((files: readonly SessionFileChange[]) => {
    const next = new Set([...marks, ...files.map(reviewId)])
    setMarks(next)
    if (!conversationId) return
    try { localStorage.setItem(committedKey(conversationId), JSON.stringify([...next].slice(-500))) } catch { /* the marks just will not persist */ }
  }, [conversationId, marks])
  return { has, add }
}
