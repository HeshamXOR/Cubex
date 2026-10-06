import type { PullProgress } from '../../../shared/ipc'

/** A download the window knows about: waiting, running, or failed and not yet dismissed. */
export type Pull = PullProgress & { pullId: string }

export interface PullsSnapshot {
  pulls: Record<string, Pull>
  /** Counts the downloads that finished, so a view can refetch what is installed when it changes. */
  finished: number
}

export const DEFAULT_RUNTIME = 'ollama'

/** One entry per model per runtime: asking for a model that is already on its way shows the same row. */
export function pullKey(p: { runtime?: string; modelId: string }): string {
  return `${p.runtime ?? DEFAULT_RUNTIME}\n${p.modelId}`
}

/**
 * Fold one progress event into the list. A finished or cancelled download leaves it, a failed one
 * stays so its reason is not lost, and everything else replaces what was there.
 */
export function applyPullEvent(snapshot: PullsSnapshot, event: Pull): PullsSnapshot {
  const key = pullKey(event)
  if (!event.done || event.error) return { ...snapshot, pulls: { ...snapshot.pulls, [key]: event } }
  const { [key]: _gone, ...rest } = snapshot.pulls
  const succeeded = event.status === 'success' || event.phase === 'done'
  return { pulls: rest, finished: snapshot.finished + (succeeded ? 1 : 0) }
}

/** The download in progress first, then those waiting in order, then failures. */
export function sortPulls(pulls: Record<string, Pull>): Pull[] {
  const rank = (p: Pull): number => (p.error ? 2 : p.phase === 'queued' ? 1 : 0)
  return Object.values(pulls)
    .map((pull, index) => ({ pull, index }))
    .sort((a, b) => rank(a.pull) - rank(b.pull) || (a.pull.queuePosition ?? 0) - (b.pull.queuePosition ?? 0) || a.index - b.index)
    .map(({ pull }) => pull)
}

/** The row the person sees the instant they ask, before the first event has come back. */
export function startingPull(runtime: string, modelId: string): Pull {
  return { pullId: '', runtime, modelId, status: 'preparing', phase: 'preparing', done: false }
}

export function failedPull(runtime: string, modelId: string, error: string): Pull {
  return { pullId: '', runtime, modelId, status: 'error', phase: 'error', errorCode: 'failed', done: true, error }
}
