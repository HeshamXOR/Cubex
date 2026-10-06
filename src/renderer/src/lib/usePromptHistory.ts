import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  HISTORY_STORAGE_KEY,
  NOT_RECALLING,
  clearPrompts,
  leaveRecall,
  loadPrompts,
  mayRecallNewer,
  mayRecallOlder,
  projectKey,
  recallNewer,
  recallOlder,
  recordPrompt,
  settleRecall,
  type PromptStorage,
  type Recall
} from './promptHistory'

/** Where history lives when the browser will not hand out storage: it lasts until the window closes. */
const heldInMemory = new Map<string, string>()
const memoryStorage: PromptStorage = {
  getItem: (key) => heldInMemory.get(key) ?? null,
  setItem: (key, value) => { heldInMemory.set(key, value) },
  removeItem: (key) => { heldInMemory.delete(key) }
}

function storage(): PromptStorage {
  try {
    return window.localStorage
  } catch {
    return memoryStorage
  }
}

/** The part of a text field that decides whether an arrow key belongs to history or to the caret. */
export interface CaretField {
  value: string
  selectionStart: number
  selectionEnd: number
}

export interface PromptHistory {
  /** Prompts remembered for this project. */
  count: number
  /** 1 is the newest prompt while walking back through them; 0 when the composer holds what is being typed. */
  position: number
  record: (text: string) => void
  /** Forget this project's prompts; returns how many there were. */
  clear: () => number
  /** Up, Down and Esc. True when history used the key; false means the key keeps its usual job. */
  older: (field: CaretField) => boolean
  newer: (field: CaretField) => boolean
  leave: () => boolean
}

/**
 * Prompt history for the composer of one task. `scope` is the task: switching it ends any walk through
 * prompts, because the composer then shows a different draft.
 */
export function usePromptHistory(workspace: string | undefined, scope: string | undefined, text: string, setText: (text: string) => void): PromptHistory {
  const key = projectKey(workspace)
  const [version, setVersion] = useState(0)
  const prompts = useMemo(() => loadPrompts(storage(), key), [key, version])
  // The walk is read inside key handlers, so it lives in a ref and is mirrored to state only for drawing.
  const recallRef = useRef<Recall>(NOT_RECALLING)
  const [position, setPosition] = useState(0)

  const move = useCallback((next: Recall): void => {
    recallRef.current = next
    setPosition(next.index === null ? 0 : next.index + 1)
  }, [])

  // Typing, a restore or any other change to the text ends the walk: the composer is the person's again.
  useEffect(() => {
    const settled = settleRecall(recallRef.current, text)
    if (settled !== recallRef.current) move(settled)
  }, [text, move])
  useEffect(() => { move(NOT_RECALLING) }, [key, scope, move])
  // Another window of the app sharing this storage can add or clear prompts; the browser tells this one with a `storage` event.
  useEffect(() => {
    const changed = (event: StorageEvent): void => {
      if (event.key === null || event.key === HISTORY_STORAGE_KEY) setVersion((current) => current + 1)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const step = (next: { text: string; recall: Recall } | undefined): boolean => {
    if (!next) return false
    setText(next.text)
    move(next.recall)
    return true
  }

  return {
    count: prompts.length,
    position,
    record: (value) => {
      recordPrompt(storage(), key, value)
      setVersion((current) => current + 1)
      move(NOT_RECALLING)
    },
    clear: () => {
      const removed = clearPrompts(storage(), key)
      setVersion((current) => current + 1)
      move(NOT_RECALLING)
      return removed
    },
    older: (field) => {
      const recall = recallRef.current
      return mayRecallOlder(field.value, field.selectionStart, field.selectionEnd, recall.index !== null) && step(recallOlder(prompts, recall, field.value))
    },
    newer: (field) => {
      const recall = recallRef.current
      return mayRecallNewer(field.value, field.selectionStart, field.selectionEnd, recall.index !== null) && step(recallNewer(prompts, recall, field.value))
    },
    leave: () => step(leaveRecall(recallRef.current))
  }
}
