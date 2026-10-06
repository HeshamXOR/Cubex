import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { usePrefersReducedMotion } from './useSmoothText'

/** Half-life of the glide, in seconds: the distance to the bottom shrinks by 1/e every 70 ms. */
const GLIDE_TAU = 0.07
/** Closer than this to the bottom counts as at the bottom. */
const STICK_DISTANCE = 24
/** The scroll-to-latest button appears once the reader is this far from the bottom. */
const BUTTON_DISTANCE = 80

/**
 * Keeps a growing thread pinned to its bottom the way a person scrolling would:
 * as content grows the view eases down to it, instead of jumping a step per update.
 * Scrolling up (wheel, keys, scrollbar, touch) lets go; returning to the bottom, or
 * pressing the button, picks the thread up again.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement>,
  content: RefObject<HTMLElement>,
  resetKey: string | undefined
): { atBottom: boolean; scrollToBottom: () => void } {
  const reduced = usePrefersReducedMotion()
  const stuck = useRef(true)
  const frame = useRef(0)
  const lastTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  const glide = useCallback(() => {
    if (frame.current) return
    let last = performance.now()
    const step = (now: number): void => {
      frame.current = 0
      const el = scroller.current
      if (!el || !stuck.current) return
      const goal = el.scrollHeight - el.clientHeight
      const gap = goal - el.scrollTop
      if (gap <= 0.5) {
        el.scrollTop = goal
        lastTop.current = el.scrollTop
        return
      }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // Ease toward a goal that may still be moving; always advance a little so it finishes.
      el.scrollTop += reduced ? gap : Math.min(gap, Math.max(gap * (1 - Math.exp(-dt / GLIDE_TAU)), 1))
      lastTop.current = el.scrollTop
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [scroller, reduced])

  // A different conversation starts at its bottom, with no travel.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    stuck.current = true
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    setAtBottom(true)
  }, [scroller, resetKey])

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el) return
    const follow = (): void => { if (stuck.current) glide() }
    const observer = new ResizeObserver(follow)
    observer.observe(el)
    if (inner) observer.observe(inner)

    const onScroll = (): void => {
      const top = el.scrollTop
      const distance = el.scrollHeight - el.clientHeight - top
      // Only the reader moves the view up; the glide and a shrinking thread never do.
      if (top < lastTop.current - 1 && distance > 4) stuck.current = false
      else if (distance < STICK_DISTANCE) stuck.current = true
      lastTop.current = top
      setAtBottom(distance < BUTTON_DISTANCE)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) stuck.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [scroller, content, glide])

  const scrollToBottom = useCallback(() => {
    stuck.current = true
    glide()
  }, [glide])

  return { atBottom, scrollToBottom }
}
