import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { languageFor, tokenizeLine, type Lang } from '../../lib/highlight'
import { useVirtualWindow } from '../../lib/useVirtualWindow'
import { splitLines } from '../../../../shared/workspaceFile'

/** Every line is exactly this tall, which is what lets a 50,000 line file scroll without rendering 50,000 rows. */
const LINE_HEIGHT = 20
/** A longer line is shown without colors: the highlighter reads one line at a time and a minified file is one huge line. */
const HIGHLIGHT_MAX_CHARS = 1_000
/** A longer line is cut, and says how much is missing. */
const RENDER_MAX_CHARS = 10_000

interface LineProps {
  no: number
  text: string
  lang: Lang
  hit: boolean
  onPick: (no: number) => void
}

const Line = memo(function Line({ no, text, lang, hit, onPick }: LineProps): JSX.Element {
  const cut = text.length > RENDER_MAX_CHARS
  const shown = cut ? text.slice(0, RENDER_MAX_CHARS) : text
  const tokens = useMemo(() => (shown.length > HIGHLIGHT_MAX_CHARS ? [{ text: shown }] : tokenizeLine(shown, lang)), [shown, lang])
  return (
    <div className="fx-line" data-hit={hit || undefined}>
      <button type="button" className="fx-no" tabIndex={-1} aria-label={`Mark line ${no}`} onClick={() => onPick(no)}>{no}</button>
      <span className="fx-src">
        {tokens.map((token, index) => (token.cls ? <span key={index} className={`tk-${token.cls}`}>{token.text}</span> : token.text))}
        {cut && <span className="fx-cut">{` … ${(text.length - RENDER_MAX_CHARS).toLocaleString()} more characters`}</span>}
      </span>
    </div>
  )
})

interface CodeViewProps {
  path: string
  text: string
  /** The marked line. */
  line: number | undefined
  /** Counts requests to scroll to `line`, so asking again for the same line scrolls again. */
  focus: number
  onPick: (line: number | undefined) => void
}

/** A file with line numbers and colors. Only the lines in view exist as elements. */
export function CodeView({ path, text, line, focus, onPick }: CodeViewProps): JSX.Element {
  const lines = useMemo(() => splitLines(text), [text])
  const lang = useMemo(() => languageFor(path), [path])
  const scroller = useRef<HTMLDivElement>(null)
  const { start, end, height, reveal } = useVirtualWindow(scroller, { count: lines.length, rowHeight: LINE_HEIGHT, overscan: 24 })
  const widest = useMemo(() => lines.reduce((most, current) => Math.max(most, Math.min(current.length, RENDER_MAX_CHARS + 40)), 0), [lines])

  // `reveal` changes whenever the file's length does; going to a line is only wanted when one is asked for.
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  useEffect(() => {
    if (line && line <= lines.length) revealRef.current(line - 1, 'center')
  }, [path, line, focus, lines.length])

  // Picking the marked line again unmarks it. The handler stays the same object so the visible lines are not redrawn for it.
  const markedRef = useRef(line)
  markedRef.current = line
  const pick = useCallback((no: number) => onPick(no === markedRef.current ? undefined : no), [onPick])
  const digits = Math.max(String(lines.length).length, 2)

  return (
    <div ref={scroller} className="fx-code" tabIndex={0} role="region" aria-label={`Contents of ${path}`} style={{ '--digits': digits } as CSSProperties}>
      <div className="fx-code__sizer" style={{ height, minWidth: `calc(${digits}ch + 26px + ${widest}ch + 32px)` }}>
        <div className="fx-code__rows" style={{ transform: `translateY(${start * LINE_HEIGHT}px)` }}>
          {lines.slice(start, end).map((content, offset) => (
            <Line key={start + offset} no={start + offset + 1} text={content} lang={lang} hit={start + offset + 1 === line} onPick={pick} />
          ))}
        </div>
      </div>
    </div>
  )
}
