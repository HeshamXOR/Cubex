import { TriangleAlert } from 'lucide-react'
import type { SessionFileChange } from '../../../shared/ipc'
import type { HunkActions } from '../lib/useHunkActions'
import type { ReviewData } from '../lib/useReview'
import { DiffView, type DiffMode } from './DiffView'
import { HunkDiff } from './HunkDiff'

interface Props {
  file: SessionFileChange
  review: ReviewData
  conversationId: string
  mode: DiffMode
  /** Cubex is mid-turn, which holds undoing back. */
  working: boolean
  /** A change to the files is being made, which holds the next back. */
  busy: boolean
  actions: HunkActions
}

/** Why a file has nothing to show hunk by hunk, in the words the panel has always used for it. */
const NO_PREVIEW = 'There is no text preview for this file. It may be binary, very large or not UTF-8. You can still undo it.'

/**
 * The diff of the file being read. It is shown hunk by hunk when the main process could split it; otherwise the whole-file
 * diff stays, with a note saying why. Binary and oversize files are reviewed per file, as before.
 */
export function FileReview({ file, review, conversationId, mode, working, busy, actions }: Props): JSX.Element {
  if (!review.loaded) return <div className="rev-nodiff" role="status">Loading hunks…</div>

  const hunks = review.files.find((entry) => entry.path === file.path)
  if (hunks && !hunks.binary && !hunks.oversize && hunks.hunks.length) {
    return <HunkDiff key={file.path} file={hunks} conversationId={conversationId} mode={mode} working={working} busy={busy} handlers={actions.handlers} />
  }

  const wholeFile = file.diff
    ? <DiffView key={`${file.path}:${file.updatedAt}`} diff={file.diff} path={file.path} mode={mode} />
    : <div className="rev-nodiff"><p>{NO_PREVIEW}</p></div>

  // A file that cannot be shown as text is not a failure: there is nothing to say beyond what the panel always said.
  if (hunks?.binary || hunks?.oversize) return <div className="rev-nodiff"><p>{NO_PREVIEW}</p></div>
  if (hunks?.formatChanged) {
    return <div className="rev-nodiff"><p>Only the line endings or the byte-order mark of this file changed, so there are no lines to compare. You can still undo it.</p></div>
  }
  if (hunks) return wholeFile

  return (
    <>
      <div className="callout callout--warn" role="status">
        <TriangleAlert size={15} aria-hidden="true" />
        <div className="callout__body">
          <strong>{review.error ? 'Hunk review is not available' : 'No hunks for this file yet'}</strong>
          {review.error
            ? `${review.error} The whole-file diff is shown instead, and you can still keep or undo the file.`
            : 'The whole-file diff is shown instead, and you can still keep or undo the file.'}
        </div>
        <div className="callout__actions">
          <button type="button" className="callout__action" onClick={() => void review.refresh()}>Try again</button>
        </div>
      </div>
      {wholeFile}
    </>
  )
}
