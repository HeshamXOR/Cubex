import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { useStore } from '../state/store'
import { activitySpecFor } from '../status/StatusIndicator'
import { EDIT_TOOLS } from './transcriptGroups'
import type { SessionFileChange } from '../../../shared/ipc'

/**
 * Changes whenever an edit finishes or a turn starts or ends, the moments the
 * list of changed files can differ. A string, so a streamed word never counts.
 */
function useChangeSignal(): string {
  return useStore((state) => {
    let finished = 0
    for (const message of state.liveMessages) {
      for (const tool of message.toolCalls ?? []) {
        if (EDIT_TOOLS.has(tool.name) && tool.phase !== 'running' && tool.phase !== 'queued') finished++
      }
    }
    return `${finished}:${activitySpecFor(state.status).active ? 'working' : 'idle'}`
  })
}

export interface SessionChanges {
  files: SessionFileChange[]
  /** False until the first answer for this conversation arrives. */
  loaded: boolean
  error?: string
  /** Counts the times the main process said this conversation's review changed: the cue to read its hunks again. */
  revision: number
  refresh: () => void
}

/** The net file changes of a conversation, kept current as the agent works. */
export function useSessionChanges(conversationId: string | undefined, enabled = true): SessionChanges {
  const signal = useChangeSignal()
  const [version, setVersion] = useState(0)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ owner?: string; files: SessionFileChange[]; error?: string }>({ files: [] })

  useEffect(() => {
    if (!conversationId || !enabled) return
    return api.onChatEvent((event) => {
      if (event.kind === 'review' && event.conversationId === conversationId) setRevision((count) => count + 1)
    })
  }, [conversationId, enabled])

  useEffect(() => {
    if (!conversationId || !enabled) return
    let alive = true
    // The edit that triggered this has just finished; give its write a moment to land.
    const timer = window.setTimeout(() => {
      api.getSessionChanges(conversationId).then(
        (files) => { if (alive) setState({ owner: conversationId, files }) },
        (cause: unknown) => { if (alive) setState({ owner: conversationId, files: [], error: cause instanceof Error ? cause.message : 'Changes could not be loaded.' }) }
      )
    }, 220)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [conversationId, enabled, signal, version, revision])

  const refresh = useCallback(() => setVersion((current) => current + 1), [])
  const current = state.owner === conversationId
  return { files: current ? state.files : [], loaded: current, error: current ? state.error : undefined, revision, refresh }
}

function reviewedKey(conversationId: string): string {
  return `cubex.reviewed.${conversationId}`
}

function loadReviewed(conversationId: string | undefined): Set<string> {
  if (!conversationId) return new Set()
  try {
    const raw = localStorage.getItem(reviewedKey(conversationId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

/** A file is reviewed for the version Cubex last wrote; a later edit asks for a new look. */
export function reviewId(file: Pick<SessionFileChange, 'path' | 'updatedAt'>): string {
  return `${file.path}@${file.updatedAt}`
}

export interface Reviewed {
  isReviewed: (file: SessionFileChange) => boolean
  toggle: (file: SessionFileChange) => void
  markAll: (files: readonly SessionFileChange[]) => void
  count: number
}

/** Which changed files the person has looked at. Kept per conversation, on this machine only. */
export function useReviewed(conversationId: string | undefined, files: readonly SessionFileChange[]): Reviewed {
  const [marks, setMarks] = useState(() => loadReviewed(conversationId))
  useEffect(() => setMarks(loadReviewed(conversationId)), [conversationId])

  const save = useCallback((next: Set<string>) => {
    setMarks(next)
    if (!conversationId) return
    try { localStorage.setItem(reviewedKey(conversationId), JSON.stringify([...next].slice(-500))) } catch { /* the marks just will not persist */ }
  }, [conversationId])

  const isReviewed = useCallback((file: SessionFileChange) => marks.has(reviewId(file)), [marks])
  const toggle = useCallback((file: SessionFileChange) => {
    const next = new Set(marks)
    const id = reviewId(file)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save(next)
  }, [marks, save])
  const markAll = useCallback((all: readonly SessionFileChange[]) => save(new Set([...marks, ...all.map(reviewId)])), [marks, save])
  const count = useMemo(() => files.filter((file) => marks.has(reviewId(file))).length, [files, marks])
  return { isReviewed, toggle, markAll, count }
}

export interface ChangesContextValue {
  changes: SessionChanges
  reviewed: Reviewed
}

const ChangesContext = createContext<ChangesContextValue | undefined>(undefined)

/** Narrow windows keep the conversation to themselves until the person opens the review. */
const AUTO_OPEN_MIN_WIDTH = 1200

/**
 * One source of truth for the open conversation's file changes, shared by the header's
 * badge and the review panel. The panel opens by itself the first time a conversation
 * changes a file while it is on screen, if there is room for it beside the thread.
 */
export function ChangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const changes = useSessionChanges(conversationId)
  const reviewed = useReviewed(conversationId, changes.files)
  const seen = useRef<{ id?: string; empty: boolean }>({ empty: false })
  const opened = useRef(new Set<string>())

  useEffect(() => {
    if (seen.current.id !== conversationId) seen.current = { id: conversationId, empty: false }
    if (!conversationId || !changes.loaded) return
    if (changes.files.length === 0) {
      seen.current.empty = true
      return
    }
    // Only the move from nothing to something, observed live, opens the panel.
    if (seen.current.empty && !opened.current.has(conversationId) && window.innerWidth >= AUTO_OPEN_MIN_WIDTH) {
      opened.current.add(conversationId)
      const state = useStore.getState()
      if (!state.panelOpen) state.openReview(changes.files[0]?.path)
    }
    seen.current.empty = false
  }, [conversationId, changes.loaded, changes.files])

  const value = useMemo(() => ({ changes, reviewed }), [changes, reviewed])
  return createElement(ChangesContext.Provider, { value }, children)
}

export function useChanges(): ChangesContextValue {
  const value = useContext(ChangesContext)
  if (!value) throw new Error('useChanges needs a ChangesProvider above it.')
  return value
}
