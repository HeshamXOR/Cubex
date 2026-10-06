import { Fragment, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { DiffRow, SplitRow } from '../lib/diffModel'
import type { Lang } from '../lib/highlight'
import { describeRangeInline, rowRange, type CommentRange } from '../lib/hunkReview'
import { Cell, Unified } from './DiffView'

/** Shown over the line numbers of a changed line while the pointer is on it: the quick way to comment on that one line. */
function AddComment({ range, onComment }: { range: CommentRange; onComment: (range: CommentRange) => void }): JSX.Element {
  const label = `Comment on ${describeRangeInline(range)}`
  return (
    <button type="button" className="dl__add" tabIndex={-1} aria-label={label} title={label} onClick={() => onComment(range)}>
      <Plus size={12} aria-hidden="true" />
    </button>
  )
}

interface Props {
  rows: readonly DiffRow[]
  /** The same rows laid out side by side; absent in the unified layout. */
  split?: readonly SplitRow[]
  lang: Lang
  /** What goes under the row at each index of the layout in use: comments and the editor. */
  notes: ReadonlyMap<number, ReactNode>
  /** Absent when no more comments can be added. */
  onComment?: (range: CommentRange) => void
}

/** The lines of one hunk, each changed line with its comment button, and the notes under the rows they belong to. */
export function HunkRows({ rows, split, lang, notes, onComment }: Props): JSX.Element {
  const offer = (row: DiffRow | undefined, kind: 'add' | 'del'): ReactNode => {
    const range = row && row.kind === kind ? rowRange(row) : undefined
    return range && onComment ? <AddComment range={range} onComment={onComment} /> : undefined
  }
  if (split) {
    return (
      <>
        {split.map((item, index) => (
          <Fragment key={index}>
            <div className="ds" role="row">
              <Cell row={item.left} side="left" lang={lang} add={offer(item.left, 'del')} />
              <Cell row={item.right} side="right" lang={lang} add={offer(item.right, 'add')} />
            </div>
            {notes.get(index)}
          </Fragment>
        ))}
      </>
    )
  }
  return (
    <>
      {rows.map((row, index) => (
        <Fragment key={index}>
          <Unified row={row} lang={lang} add={offer(row, row.kind === 'del' ? 'del' : 'add')} />
          {notes.get(index)}
        </Fragment>
      ))}
    </>
  )
}
