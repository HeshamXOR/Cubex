import { memo, useMemo, type ReactNode } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { parseDiff, toSplit, type DiffRow } from '../lib/diffModel'
import { languageFor, pieces, type Lang } from '../lib/highlight'

export type DiffMode = 'unified' | 'split'

/** One line of code, colored, with the words that changed emphasized. */
export const Code = memo(function Code({ row, lang, cell }: { row: DiffRow; lang: Lang; cell?: boolean }): JSX.Element {
  const parts = useMemo(() => pieces(row.text, lang, row.marks), [row.text, lang, row.marks])
  return (
    <span className="cd" role={cell ? 'cell' : undefined}>
      {parts.map((part, index) => (
        <span key={index} className={`${part.cls ? `tk-${part.cls}` : ''}${part.marked ? ' wd' : ''}`.trim() || undefined}>{part.text}</span>
      ))}
      {row.text === '' && ' '}
    </span>
  )
})

/** The + or − beside a changed line; assistive technology hears the word instead of the symbol. */
export function Sign({ kind, cell }: { kind: DiffRow['kind']; cell?: boolean }): JSX.Element {
  return (
    <span className="sg" role={cell ? 'cell' : undefined}>
      {kind !== 'ctx' && (
        <>
          <span aria-hidden="true">{kind === 'add' ? '+' : '−'}</span>
          <span className="sr-only">{kind === 'add' ? 'Added' : 'Removed'}</span>
        </>
      )}
    </span>
  )
}

/** A unified line. `add` is whatever sits over the line numbers, such as the button that comments on the line. */
export const Unified = memo(function Unified({ row, lang, add }: { row: DiffRow; lang: Lang; add?: ReactNode }): JSX.Element {
  return (
    <div className={`dl ${row.kind}`} role="row">
      <span className="o" role="cell">{row.oldNo ?? ''}{add}</span>
      <span className="n" role="cell">{row.newNo ?? ''}</span>
      <Sign kind={row.kind} cell />
      <Code row={row} lang={lang} cell />
    </div>
  )
})

/** One side of a split line, with `add` over its line number. */
export function Cell({ row, side, lang, add }: { row?: DiffRow; side: 'left' | 'right'; lang: Lang; add?: ReactNode }): JSX.Element {
  if (!row) return <div className="dc dc--blank" aria-hidden="true" />
  return (
    <div className={`dc ${row.kind}`} role="cell">
      <span className="n">{(side === 'left' ? row.oldNo : row.newNo) ?? ''}</span>
      <Sign kind={row.kind} />
      <Code row={row} lang={lang} />
      {add}
    </div>
  )
}

/** A hunk header or a note about collapsed lines: one row with one cell that spans the diff, after an optional icon. */
export function NoteRow({ className, icon, children }: { className: string; icon?: ReactNode; children: ReactNode }): JSX.Element {
  return <div className={className} role="row">{icon}<span role="cell">{children}</span></div>
}

/**
 * A reviewable diff: line numbers on both sides, hunk headers, collapsed unchanged
 * runs, syntax colors and word-level emphasis. Unified keeps long lines on one row
 * and scrolls sideways; split wraps them so both sides stay in view.
 */
export function DiffView({ diff, path, mode }: { diff: string; path: string; mode: DiffMode }): JSX.Element {
  const items = useMemo(() => parseDiff(diff), [diff])
  const split = useMemo(() => (mode === 'split' ? toSplit(items) : []), [items, mode])
  const lang = languageFor(path)

  if (mode === 'split') {
    return (
      <div className="diff diff--split" role="table" aria-label={`Changes to ${path}`} tabIndex={0}>
        {split.map((item, index) => {
          if (item.kind === 'hunk') return <NoteRow className="dh" key={index}>{item.header}</NoteRow>
          if (item.kind === 'gap') return <NoteRow className="dmore" icon={<ChevronsUpDown size={13} aria-hidden="true" />} key={index}>{item.text}</NoteRow>
          return (
            <div className="ds" key={index} role="row">
              <Cell row={item.left} side="left" lang={lang} />
              <Cell row={item.right} side="right" lang={lang} />
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="diff diff--unified" role="table" aria-label={`Changes to ${path}`} tabIndex={0}>
      <div className="diff__body" role="rowgroup">
        {items.map((item, index) => {
          if (item.kind === 'hunk') return <NoteRow className="dh" key={index}>{item.header}</NoteRow>
          if (item.kind === 'gap') return <NoteRow className="dmore" icon={<ChevronsUpDown size={13} aria-hidden="true" />} key={index}>{item.text}</NoteRow>
          return <Unified key={index} row={item} lang={lang} />
        })}
      </div>
    </div>
  )
}
