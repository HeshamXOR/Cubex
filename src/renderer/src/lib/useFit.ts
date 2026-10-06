import { useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { densityFor, pickFitting, type ComposerDensity } from './composerLayout'

let canvas: CanvasRenderingContext2D | null | undefined

/** Text width in a font, from a canvas that is never drawn: the field's own wrapping cannot be asked. */
function measureIn(font: string): (text: string) => number {
  canvas ??= document.createElement('canvas').getContext('2d')
  const context = canvas
  return (text) => {
    if (!context) return 0
    context.font = font
    return context.measureText(text).width
  }
}

interface Box {
  /** Room for text: the width inside the padding. */
  width: number
  font: string
}

/** The text room and font of an element, kept current as it resizes and as web fonts arrive. */
function useBox(ref: RefObject<HTMLElement>): Box {
  const [box, setBox] = useState<Box>({ width: 0, font: '' })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let alive = true
    const read = (): void => {
      if (!alive) return
      const style = getComputedStyle(element)
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setBox((current) => (current.width === width && current.font === style.font ? current : { width, font: style.font }))
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    // A web font that arrives late changes every width.
    void document.fonts.ready.then(read)
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [ref])
  return box
}

/** The longest of the candidates (longest first) that fits on one line in the element. */
export function useFittedText(ref: RefObject<HTMLElement>, candidates: readonly string[]): string {
  const { width, font } = useBox(ref)
  const wordings = candidates.join('\n')
  // `wordings` stands in for `candidates`, which is a new array on every render.
  return useMemo(() => pickFitting(candidates, width, measureIn(font)), [wordings, width, font])
}

/** How much of the composer's bar fits in the element's width. */
export function useDensity(ref: RefObject<HTMLElement>): ComposerDensity {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const read = (): void => setWidth(element.offsetWidth)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return densityFor(width)
}
