import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface RowRange {
  /** First row to render. */
  start: number
  /** One past the last row to render. */
  end: number
}

/** Used until the container reports its height, so the first paint already has rows. */
const ASSUMED_VIEWPORT = 600

/** The rows to render for a scroll position: what is on screen, plus a few rows of margin either side. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan: number): RowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const height = viewport > 0 ? viewport : ASSUMED_VIEWPORT
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const last = Math.ceil((Math.max(0, scrollTop) + height) / rowHeight)
  return { start: Math.max(0, Math.min(first, count) - overscan), end: Math.min(count, Math.max(last, 0) + overscan) }
}

interface VirtualWindow extends RowRange {
  /** Total height of all rows, for the spacer that gives the scrollbar its size. */
  height: number
  /** Scroll so the row is in view; `center` puts it in the middle of the viewport. */
  reveal: (index: number, align?: 'nearest' | 'center') => void
}

/**
 * Renders only the rows of a long list that are on screen. Rows have one fixed height, which is what
 * lets the position of any row, and the size of the scrollbar, be known without measuring them.
 */
export function useVirtualWindow(container: RefObject<HTMLElement | null>, options: { count: number; rowHeight: number; overscan?: number }): VirtualWindow {
  const { count, rowHeight, overscan = 12 } = options
  const [range, setRange] = useState<RowRange>(() => visibleRange(0, 0, rowHeight, count, overscan))
  const frame = useRef(0)

  const measure = useCallback(() => {
    const element = container.current
    if (!element) return
    const next = visibleRange(element.scrollTop, element.clientHeight, rowHeight, count, overscan)
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next))
  }, [container, count, rowHeight, overscan])

  // The count can shrink under the scroll position (a folder closes, a search narrows), so measure whenever it changes.
  useLayoutEffect(measure, [measure])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const onScroll = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(measure)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame.current)
      element.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [container, measure])

  const reveal = useCallback((index: number, align: 'nearest' | 'center' = 'nearest') => {
    const element = container.current
    if (!element || index < 0) return
    const top = index * rowHeight
    if (align === 'center') {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2 + rowHeight / 2)
    } else if (top < element.scrollTop) {
      element.scrollTop = top
    } else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight
    }
    measure()
  }, [container, rowHeight, measure])

  return { ...range, height: count * rowHeight, reveal }
}
