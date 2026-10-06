import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createSmoother, stepSmoother, type SmootherState } from './smoothText'

/** A block that mounts with at most this much text is new, and animates from its first word. */
const FRESH_BLOCK = 120

const REDUCED = '(prefers-reduced-motion: reduce)'

/** One query and one listener serve every component; a long thread would otherwise hold a pair per message. */
let reducedQuery: MediaQueryList | undefined
const reducedListeners = new Set<() => void>()
const notifyReduced = (): void => reducedListeners.forEach((listener) => listener())
const reducedMotion = (): MediaQueryList => (reducedQuery ??= window.matchMedia(REDUCED))

function subscribeReducedMotion(notify: () => void): () => void {
  const query = reducedMotion()
  if (reducedListeners.size === 0) query.addEventListener('change', notifyReduced)
  reducedListeners.add(notify)
  return () => {
    reducedListeners.delete(notify)
    if (reducedListeners.size === 0) query.removeEventListener('change', notifyReduced)
  }
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotion().matches, () => false)
}

/**
 * The part of `target` that should be on screen right now. While `live`, text
 * that arrives in network bursts is revealed as a steady flow of whole words;
 * once `live` ends the remainder finishes within a fraction of a second.
 * Finished text (a saved message, or one that was already long when this
 * mounted) is returned as is, with no animation.
 */
export function useSmoothText(target: string, live: boolean): string {
  const reduced = usePrefersReducedMotion()
  const [shown, setShown] = useState(() => (live && target.length <= FRESH_BLOCK ? 0 : target.length))
  const smoother = useRef<SmootherState | null>(null)
  smoother.current ??= createSmoother(shown, target.length, performance.now())
  const latest = useRef({ target, live })
  latest.current = { target, live }
  const frame = useRef(0)

  const start = useCallback(() => {
    if (frame.current) return
    const tick = (now: number): void => {
      frame.current = 0
      const state = smoother.current!
      const { target: text, live: isLive } = latest.current
      const more = stepSmoother(state, text, now, isLive)
      setShown(state.shown)
      if (more) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (!reduced && (live || smoother.current!.shown < target.length)) start()
  }, [target, live, reduced, start])
  useEffect(() => () => {
    // Clear the id too: a remount (StrictMode, tab restore) must be able to start again.
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])

  if (reduced || shown >= target.length) return target
  return target.slice(0, shown)
}
