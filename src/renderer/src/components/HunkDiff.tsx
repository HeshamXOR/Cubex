import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { nanoid } from 'nanoid'
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, MessageSquare, MessageSquarePlus, Pencil, Redo2, RefreshCw, TriangleAlert, Undo2, X } from 'lucide-react'
import type { ReviewFile, ReviewHunk } from '../../../shared/ipc'
import { plural } from '../lib/format'
import { languageFor, type Lang } from '../lib/highlight'
import { focusHunk, focusIsLost, isTyping, stepHunk } from '../lib/hunkNav'
import { describeRange, describeRangeInline, excerptOf, hunkAnchor, hunkItems, hunkRows, noteIndex, splitHunkRows, staleReason, unchangedBefore, type CommentRange } from '../lib/hunkReview'
import { matchesShortcut } from '../lib/shortcuts'
import type { HunkHandlers } from '../lib/useHunkActions'
import { MAX_QUEUED_COMMENTS, useQueuedComments, useReviewComments, type QueuedComment } from '../state/reviewComments'
import { staleKey, useCommentDrafts, useReviewSession, useStaleMarks, useUndoneHunks, type CommentDraft, type StaleMark, type UndoneHunk } from '../state/reviewSession'
import { Stat } from './ChangeStat'
import { CommentEditor } from './CommentEditor'
import { NoteRow, type DiffMode } from './DiffView'
import { HunkRows } from './HunkLines'
import './hunks.css'

interface Shared {
  file: ReviewFile
  conversationId: string
  lang: Lang
  mode: DiffMode
  /** Cubex is mid-turn and could be writing the file, so undoing waits. */
  working: boolean
  /** Another change to the review is being made; one at a time keeps each against the file as it then is. */
  busy: boolean
  /** The queue holds as many comments as one message can carry. */
  full: boolean
  handlers: HunkHandlers
  /** Called as a change's own controls are used, so focus stays with that change when they change or go away. */
  keepPlace: (hunkId: string | undefined) => void
}

const count = (lines: readonly string[], tag: '+' | '-'): number => lines.filter((line) => line[0] === tag).length

const undoLabel = (file: ReviewFile): string =>
  file.status === 'added' ? 'Remove the file Cubex created' : file.status === 'deleted' ? 'Put the deleted file back' : 'Undo this change'

/**
 * The hunks of one file, each with Keep, Undo and Comment, and in place the hunks undone this session. J and K move the
 * keyboard between them.
 */
export function HunkDiff({ file, conversationId, mode, working, busy, handlers }: { file: ReviewFile; conversationId: string; mode: DiffMode; working: boolean; busy: boolean; handlers: HunkHandlers }): JSX.Element {
  const queued = useQueuedComments(conversationId)
  const drafts = useCommentDrafts(conversationId)
  const marks = useStaleMarks(conversationId)
  const undoneAll = useUndoneHunks(conversationId)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const root = useRef<HTMLDivElement>(null)
  /** The change whose own controls were just used. */
  const place = useRef<string | undefined>(undefined)

  // Keeping or undoing a change takes away the button that had focus, and focus would drop to the page. Once the work is
  // done it goes to the change itself, where it stays until the next key or click.
  useLayoutEffect(() => {
    if (!busy && place.current && root.current && focusIsLost(root.current)) focusHunk(root.current, place.current)
  })
  useEffect(() => {
    const forget = (): void => { place.current = undefined }
    document.addEventListener('pointerdown', forget, true)
    return () => document.removeEventListener('pointerdown', forget, true)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    place.current = undefined
    if (event.defaultPrevented || isTyping(event.target)) return
    const direction = matchesShortcut(event, 'nextHunk') ? 1 : matchesShortcut(event, 'prevHunk') ? -1 : 0
    if (direction && root.current && stepHunk(root.current, direction)) event.preventDefault()
  }

  const undone = useMemo(() => undoneAll.filter((entry) => entry.path === file.path), [undoneAll, file.path])
  const items = useMemo(() => hunkItems(file.hunks, undone), [file.hunks, undone])
  const commentsOf = (hunkId: string): QueuedComment[] => queued.filter((comment) => comment.path === file.path && comment.hunkId === hunkId)
  const draftsOf = (hunkId: string): CommentDraft[] => drafts.filter((draft) => draft.path === file.path && draft.hunkId === hunkId)
  const toggle = (id: string): void => setExpanded((open) => {
    const next = new Set(open)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const shared: Shared = { file, conversationId, lang: languageFor(file.path), mode, working, busy, full: queued.length >= MAX_QUEUED_COMMENTS, handlers, keepPlace: (hunkId) => { place.current = hunkId } }
  return (
    <div ref={root} className={`diff diff--${mode} hk-diff`} role="table" aria-label={`Changes to ${file.path}`} onKeyDown={onKeyDown}>
      <div className="diff__body">
        {items.map((item, index) => {
          const gap = unchangedBefore(items[index - 1]?.hunk, item.hunk)
          return (
            <Fragment key={`${item.kind}:${item.hunk.id}:${index}`}>
              {gap > 0 && <NoteRow className="dmore" icon={<ChevronsUpDown size={13} aria-hidden="true" />}>{plural(gap, 'unchanged line')}</NoteRow>}
              {item.kind === 'hunk' ? (
                <HunkView
                  shared={shared}
                  hunk={item.hunk}
                  number={file.hunks.indexOf(item.hunk) + 1}
                  mark={marks[staleKey(file.path, item.hunk.id)]}
                  comments={commentsOf(item.hunk.id)}
                  drafts={draftsOf(item.hunk.id)}
                  expanded={expanded.has(item.hunk.id)}
                  onToggle={() => toggle(item.hunk.id)}
                />
              ) : (
                <UndoneView shared={shared} entry={item} />
              )}
            </Fragment>
          )
        })}
        {!!file.hunksOmitted && (
          <NoteRow className="dmore" icon={<ChevronsUpDown size={13} aria-hidden="true" />}>
            {`${plural(file.hunksOmitted, 'more change')} not shown. Keep or undo the whole file to deal with them.`}
          </NoteRow>
        )}
      </div>
    </div>
  )
}

interface HunkViewProps {
  shared: Shared
  hunk: ReviewHunk
  /** Its place among the file's hunks, counting from 1. */
  number: number
  mark?: StaleMark
  comments: readonly QueuedComment[]
  drafts: readonly CommentDraft[]
  expanded: boolean
  onToggle: () => void
}

function HunkView({ shared, hunk, number, mark, comments, drafts, expanded, onToggle }: HunkViewProps): JSX.Element {
  const { file, conversationId, handlers } = shared
  const openDraft = useReviewSession((state) => state.openDraft)
  const rows = useMemo(() => hunkRows(hunk), [hunk])
  const split = useMemo(() => (shared.mode === 'split' ? splitHunkRows(rows) : undefined), [rows, shared.mode])
  const state = mark ? 'stale' : hunk.state === 'accepted' ? 'kept' : 'open'
  const anchor = hunkAnchor(hunk)
  const where = describeRange(anchor)
  const showBody = state !== 'kept' || expanded || comments.length > 0 || drafts.length > 0
  const comment = (range: CommentRange): void => openDraft(conversationId, {
    id: `${hunk.id}:${range.side}:${range.startLine}-${range.endLine}`,
    path: file.path, hunkId: hunk.id, ...range, text: ''
  })

  const notes = new Map<number, ReactNode[]>()
  const put = (range: CommentRange, node: ReactNode): void => {
    const at = noteIndex(rows, split, range)
    notes.set(at, [...(notes.get(at) ?? []), node])
  }
  for (const entry of comments) {
    if (!drafts.some((draft) => draft.editing === entry.id)) put(entry, <CommentNote key={entry.id} comment={entry} shared={shared} />)
  }
  for (const draft of drafts) put(draft, <DraftNote key={draft.id} draft={draft} hunk={hunk} shared={shared} />)

  const undoWhy = shared.working ? 'Cubex is working. You can undo once its turn has finished.' : mark ? staleReason(mark.reason) : undoLabel(file)
  const stateName = state === 'kept' ? 'kept' : state === 'stale' ? 'cannot be undone' : 'to review'
  return (
    <div className={`hk hk--${state}`} role="rowgroup" data-hunk={hunk.id} tabIndex={-1} aria-label={`Change ${number}, ${describeRangeInline(anchor)}, ${stateName}`}>
      <div className="hk__h" role="row">
        <div className="hk__bar" role="cell">
          {state === 'kept' && (
            <button type="button" className="hk__chev" aria-expanded={showBody} aria-label={`${showBody ? 'Hide' : 'Show'} ${describeRangeInline(anchor)}`} onClick={onToggle}>
              {showBody ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            </button>
          )}
          <span className="hk__range" title={hunk.header}>{where}</span>
          <Stat added={count(hunk.lines, '+')} removed={count(hunk.lines, '-')} />
          {state === 'kept' && <span className="hk__tag hk__tag--kept"><Check size={12} aria-hidden="true" />Kept</span>}
          {state === 'stale' && <span className="hk__tag hk__tag--warn"><TriangleAlert size={12} aria-hidden="true" />Can't undo</span>}
          <span className="grow" />
          {state !== 'kept' && (
            <button type="button" className="btn ghost sm hk__btn" disabled={shared.busy} onClick={() => { shared.keepPlace(hunk.id); handlers.keep(file, [hunk]) }} aria-label={`Keep ${describeRangeInline(anchor)}`} title="Keep this change">
              <Check size={14} aria-hidden="true" /><span>Keep</span>
            </button>
          )}
          <button type="button" className="btn ghost sm hk__btn" disabled={shared.busy || shared.working || !!mark} onClick={() => { shared.keepPlace(hunk.id); handlers.undo(file, hunk) }} aria-label={`Undo ${describeRangeInline(anchor)}`} title={undoWhy}>
            <Undo2 size={14} aria-hidden="true" /><span>Undo</span>
          </button>
          <button type="button" className="btn ghost sm hk__btn" disabled={shared.full} onClick={() => comment(anchor)} aria-label={`Comment on ${describeRangeInline(anchor)}`} title={shared.full ? `${MAX_QUEUED_COMMENTS} comments are waiting. Send them before adding more.` : 'Comment on this change'}>
            <MessageSquarePlus size={14} aria-hidden="true" /><span>Comment</span>
          </button>
        </div>
      </div>
      {mark && (
        <div className="hk__note" role="row">
          <div className="hk__cell" role="cell">
            <div className="callout callout--warn">
              <TriangleAlert size={15} aria-hidden="true" />
              <div className="callout__body">
                <strong>This change can't be undone from here</strong>
                {staleReason(mark.reason)} Read the file again to see it as it is now.
              </div>
              <div className="callout__actions">
                <button type="button" className="callout__action" onClick={handlers.refresh}><RefreshCw size={12} aria-hidden="true" /> Refresh</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showBody && <HunkRows rows={rows} split={split} lang={shared.lang} notes={notes} onComment={shared.full ? undefined : comment} />}
    </div>
  )
}

/** A hunk that was undone: where it was, and the way back while there is one. */
function UndoneView({ shared, entry }: { shared: Shared; entry: UndoneHunk }): JSX.Element {
  const anchor = hunkAnchor(entry.hunk)
  const restorable = entry.afterHash === shared.file.headHash
  return (
    <div className="hk hk--undone" role="rowgroup" data-hunk={entry.hunk.id} tabIndex={-1} aria-label={`${describeRange(anchor)}, undone`}>
      <div className="hk__h" role="row">
        <div className="hk__bar" role="cell">
          <span className="hk__range">{describeRange(anchor)}</span>
          <Stat added={count(entry.hunk.lines, '+')} removed={count(entry.hunk.lines, '-')} />
          <span className="hk__tag"><Undo2 size={12} aria-hidden="true" />Undone</span>
          <span className="grow" />
          {restorable && (
            <button type="button" className="btn ghost sm hk__btn" disabled={shared.busy || shared.working} onClick={() => { shared.keepPlace(entry.hunk.id); shared.handlers.restore(entry) }} aria-label={`Bring it back, ${describeRangeInline(anchor)}`} title={shared.working ? 'Cubex is working. You can bring it back once its turn has finished.' : 'Put Cubex\'s change back'}>
              <Redo2 size={14} aria-hidden="true" /><span>Bring it back</span>
            </button>
          )}
        </div>
      </div>
      <div className="hk__note hk__note--quiet" role="row">
        <div className="hk__cell" role="cell">
          {restorable
            ? 'These lines are back to how they were before Cubex edited them.'
            : 'These lines are back to how they were. The file has changed since, so this undo cannot be reversed from here.'}
        </div>
      </div>
    </div>
  )
}

/** A comment waiting to be sent, under the line it is about. */
function CommentNote({ comment, shared }: { comment: QueuedComment; shared: Shared }): JSX.Element {
  const openDraft = useReviewSession((state) => state.openDraft)
  const remove = useReviewComments((state) => state.remove)
  const { conversationId } = shared
  return (
    <div className="hk__note" role="row">
      <div className="hk__cell cmt" role="cell">
        <MessageSquare size={14} aria-hidden="true" className="cmt__icon" />
        <div className="cmt__main">
          <p className="cmt__where">{describeRange(comment)}</p>
          <p className="cmt__text">{comment.text}</p>
        </div>
        <div className="cmt__actions">
          <button
            type="button"
            className="ib cmt__btn"
            aria-label={`Edit comment on ${describeRangeInline(comment)}`}
            title="Edit comment"
            onClick={() => openDraft(conversationId, { id: `edit:${comment.id}`, path: comment.path, hunkId: comment.hunkId ?? '', startLine: comment.startLine, endLine: comment.endLine, side: comment.side, text: comment.text, editing: comment.id })}
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
          <button type="button" className="ib cmt__btn" aria-label={`Remove comment on ${describeRangeInline(comment)}`} title="Remove comment" onClick={() => { shared.keepPlace(comment.hunkId); remove(conversationId, [comment.id]) }}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

/** The editor for a new comment or one being changed. */
function DraftNote({ draft, hunk, shared }: { draft: CommentDraft; hunk: ReviewHunk; shared: Shared }): JSX.Element {
  const { conversationId } = shared
  const setText = useReviewSession((state) => state.setDraftText)
  const close = useReviewSession((state) => state.closeDraft)
  const add = useReviewComments((state) => state.add)
  const edit = useReviewComments((state) => state.edit)
  const submit = (): void => {
    if (draft.editing) edit(conversationId, draft.editing, draft.text)
    else add(conversationId, { id: nanoid(), path: draft.path, hunkId: draft.hunkId, startLine: draft.startLine, endLine: draft.endLine, side: draft.side, text: draft.text, createdAt: Date.now(), excerpt: excerptOf(hunk, draft) })
    close(conversationId, draft.id)
  }
  return (
    <div className="hk__note" role="row">
      <div className="hk__cell" role="cell">
        <CommentEditor
          where={describeRangeInline(draft)}
          text={draft.text}
          onChange={(text) => setText(conversationId, draft.id, text)}
          submitLabel={draft.editing ? 'Save' : 'Add comment'}
          onSubmit={submit}
          onCancel={() => close(conversationId, draft.id)}
        />
      </div>
    </div>
  )
}
