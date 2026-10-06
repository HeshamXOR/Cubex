import { useEffect, useState } from 'react'
import type { DiagnosticItem } from '../../../shared/ipc'
import { api } from './api'
import { countProblems, isCheckedPath, type ProblemCounts } from './problemCounts'

// ---------------------------------------------------------------------------
// Current problems of a file, shared by every chip and list that asks about it
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 300
/** A clean answer is also what an unfinished check gives, so it is not trusted for long. */
const CLEAN_TTL_MS = 20_000

interface Entry {
  items: DiagnosticItem[]
  at: number
}

const cache = new Map<string, Entry>()
const pending = new Map<string, Promise<DiagnosticItem[]>>()
let lastAnswer: Promise<unknown> = Promise.resolve()

/** One question at a time: the checker answers in order anyway, and a long list must not put dozens of calls in flight. */
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = lastAnswer.then(job, job)
  lastAnswer = run.catch(() => undefined)
  return run
}

/**
 * The problems right now, not cached. A failed call is left to the caller, for a list that has to tell "none" from
 * "could not ask".
 */
export function loadProblems(conversationId: string, path?: string): Promise<DiagnosticItem[]> {
  return inTurn(() => api.getDiagnostics(conversationId, path))
}

/**
 * The problems in `path` (a task's workspace-relative file, or every file the task changed when omitted) as they are
 * on disk now. `version` names the state of the file the caller is looking at, so an edit asks again while repeated
 * renders do not. A checker that cannot answer yields an empty list, never an error.
 */
export function fetchProblems(conversationId: string, path: string | undefined, version: string | number): Promise<DiagnosticItem[]> {
  const key = `${conversationId}\0${path ?? ''}\0${version}`
  const hit = cache.get(key)
  if (hit && (hit.items.length > 0 || Date.now() - hit.at < CLEAN_TTL_MS)) return Promise.resolve(hit.items)
  const running = pending.get(key)
  if (running) return running

  const request = loadProblems(conversationId, path)
    .catch((): DiagnosticItem[] => [])
    .then((items) => {
      cache.delete(key)
      cache.set(key, { items, at: Date.now() })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
      return items
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

/** Forget what was learned about problems; for tests. */
export function resetProblemCache(): void {
  cache.clear()
  pending.clear()
  lastAnswer = Promise.resolve()
}

/**
 * The current problem counts of one changed file, for its chip. Undefined until the first answer and while there is
 * nothing to ask (checks off, no task, a file the checker does not read). The previous counts stay on screen while a
 * newer answer is on its way, so the chip does not flicker after every edit.
 */
export function useFileProblems(conversationId: string | undefined, path: string, version: string | number, enabled: boolean): ProblemCounts | undefined {
  const [counts, setCounts] = useState<ProblemCounts>()
  const task = enabled && isCheckedPath(path) ? conversationId : undefined

  useEffect(() => {
    if (!task) {
      setCounts(undefined)
      return
    }
    let alive = true
    void fetchProblems(task, path, version).then((items) => {
      if (alive) setCounts(countProblems(items))
    })
    return () => { alive = false }
  }, [task, path, version])

  return task ? counts : undefined
}
