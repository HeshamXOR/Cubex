import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Eye, FileDiff, FilePlus, FileX, GitCommitHorizontal, Undo2, X } from 'lucide-react'
import { useStore } from '../state/store'
import { lastUserMessageId } from '../state/reviewSession'
import { api, relativeTime } from '../lib/api'
import { splitPath } from '../lib/format'
import { useChanges, type Reviewed } from '../lib/useSessionChanges'
import { useCommitted } from '../lib/useCommitted'
import { useGitStatus } from '../lib/useGitStatus'
import { useHunkActions, type Notice } from '../lib/useHunkActions'
import { useReview } from '../lib/useReview'
import { activitySpecFor } from '../status/StatusIndicator'
import type { SessionFileChange } from '../../../shared/ipc'
import { Stat } from './ChangeStat'
import { CommentTray } from './CommentTray'
import { CommitSheet, type CommitDone } from './CommitSheet'
import type { DiffMode } from './DiffView'
import { FileReview } from './FileReview'
import { FileRowExtras } from './FileRowExtras'
import { ReviewProblems } from './ReviewProblems'
import './review.css'

function iconFor(file: SessionFileChange): typeof FileDiff {
  return file.status === 'added' ? FilePlus : file.status === 'deleted' ? FileX : FileDiff
}

function storedMode(): DiffMode {
  try { return localStorage.getItem('cubex.diffMode') === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}

/** The files a commit starts with: what was not committed yet, narrowed to what was reviewed when anything was. */
function defaultPicks(files: readonly SessionFileChange[], isCommitted: (file: SessionFileChange) => boolean, reviewed: Reviewed): string[] {
  const open = files.filter((file) => !isCommitted(file))
  const looked = open.filter((file) => reviewed.isReviewed(file))
  return (looked.length ? looked : open).map((file) => file.path)
}

/** The files Cubex changed in this session: review them, undo them, commit them. */
export function ChangesTab(): JSX.Element {
  const { changes, reviewed } = useChanges()
  const conversationId = useStore((s) => s.activeConversation?.id)
  const workspace = useStore((s) => (s.activeConversation ? s.activeConversation.workspacePath : s.settings?.general.workspacePath))
  const reviewFile = useStore((s) => s.reviewFile)
  const setReviewFile = useStore((s) => s.setReviewFile)
  const working = useStore((s) => !!activitySpecFor(s.status).active)
  const lastMessage = useStore((s) => lastUserMessageId(s.liveMessages))
  const [mode, setMode] = useState<DiffMode>(storedMode)
  const [notice, setNotice] = useState<Notice>()
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState<CommitDone>()
  const git = useGitStatus(conversationId)
  const committed = useCommitted(conversationId)
  const armTimer = useRef<number>()
  const { files } = changes
  const review = useReview(conversationId, changes.revision)
  const actions = useHunkActions({ conversationId, review, changes, reviewed, files, notify: setNotice })
  const hunksToKeep = review.files.some((file) => file.hunks.some((hunk) => hunk.state === 'pending'))
  const locked = busy || actions.busy
  // The way back from an undo lasts until the next message is sent.
  const canUndo = !!notice?.undo && notice.undo.userMessageId === lastMessage
  const takeBack = canUndo ? (): void => { const revertId = notice!.undo!.revertId; setNotice(undefined); void actions.restoreRevert(revertId) } : undefined
  const versions = files.map((file) => `${file.path}@${file.updatedAt}`).join('|')

  useEffect(() => { setNotice(undefined); setArmed(false); setCommitting(false); setDone(undefined) }, [conversationId])
  // A new edit makes the "Committed" line stale, and a turn makes a half-finished commit premature.
  useEffect(() => setDone(undefined), [versions])
  useEffect(() => { if (working) setCommitting(false) }, [working])
  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  // The file the thread pointed at, or the one being read; the first when neither is still there.
  const current = useMemo(() => files.find((file) => file.path === reviewFile) ?? files[0], [files, reviewFile])
  // Keep the shared choice in step with what is shown, so the thread highlights the same file.
  useEffect(() => { if (current && current.path !== reviewFile) setReviewFile(current.path) }, [current, reviewFile, setReviewFile])

  const chooseMode = (next: DiffMode): void => {
    setMode(next)
    try { localStorage.setItem('cubex.diffMode', next) } catch { /* the choice just will not persist */ }
  }

  const revert = async (paths?: string[]): Promise<void> => {
    if (!conversationId || busy) return
    setBusy(true)
    setArmed(false)
    try {
      const result = await api.revertSessionChanges(conversationId, paths)
      const restored = result.restored.length
      // The way back from this undo, offered until the next message is sent.
      const undo = result.revertId && restored ? { revertId: result.revertId, label: restored === 1 ? 'Bring it back' : 'Bring them back', userMessageId: lastMessage } : undefined
      if (result.skipped.length) {
        setNotice({
          tone: restored ? 'warn' : 'error',
          text: restored ? `Restored ${restored} ${restored === 1 ? 'file' : 'files'}. ${result.skipped.length} could not be restored.` : 'Nothing was restored.',
          details: result.skipped.map((item) => `${item.path}: ${item.reason}`),
          ...(undo ? { undo } : {})
        })
      } else {
        setNotice({ tone: 'ok', text: `Restored ${restored} ${restored === 1 ? 'file' : 'files'} to how ${restored === 1 ? 'it was' : 'they were'} before this session.`, ...(undo ? { undo } : {}) })
      }
    } catch (cause) {
      setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : 'The changes could not be undone.' })
    } finally {
      setBusy(false)
      changes.refresh()
      void review.refresh()
    }
  }

  const undoAll = (): void => {
    if (!armed) {
      setArmed(true)
      window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmed(false), 4000)
      return
    }
    void revert()
  }

  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  // Git is the source of truth for "nothing left": a clean tree has nothing to commit, whoever committed it.
  const nothingToCommit = !!git?.isRepo && !git.changedFilesUnknown && git.changedFiles === 0
  const branchLabel = git?.branch ?? (git?.head ? `Detached at ${git.head}` : 'Detached')

  if (!changes.loaded && files.length === 0) return <div className="rev-empty" role="status"><p>Loading changes…</p></div>

  if (files.length === 0) {
    return (
      <div className="rev-body">
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(undefined)} onUndo={takeBack} />}
        <div className="rev-empty">
          <FileDiff size={22} strokeWidth={1.5} aria-hidden="true" />
          <h2>{changes.error ? 'Changes could not be loaded' : 'No changes yet'}</h2>
          <p>
            {changes.error ?? (workspace
              ? 'Files Cubex edits in this session show up here with a diff for each one, so you can review them or undo them.'
              : 'Open a project folder so Cubex can edit files. Its changes will show up here.')}
          </p>
        </div>
      </div>
    )
  }

  const { dir, name } = splitPath(current!.path)
  return (
    <>
      <div className="rev-bar">
        <span className="rev-sum">
          {files.length} {files.length === 1 ? 'file' : 'files'}
          <Stat added={totalAdded} removed={totalRemoved} />
        </span>
        <span className="grow" />
        <button
          className={`btn sm ${armed ? 'btn--danger' : 'ghost'}`}
          onClick={undoAll}
          disabled={locked || working}
          title={working ? 'Stop the running turn before undoing its changes' : 'Restore every file to how it was before this session'}
        >
          <Undo2 size={14} />{armed ? 'Undo all files?' : 'Undo all'}
        </button>
        <button
          className="btn sm"
          onClick={() => { reviewed.markAll(files); void actions.keepAll() }}
          disabled={locked || (reviewed.count === files.length && !hunksToKeep)}
          title="Mark every file as reviewed and keep it"
        >
          <Check size={14} />Keep all
        </button>
      </div>
      {notice && <NoticeBar notice={notice} onClose={() => setNotice(undefined)} onUndo={takeBack} />}

      <div className="rf-list" role="list">
        {files.map((file) => {
          const Icon = iconFor(file)
          const path = splitPath(file.path)
          const done = reviewed.isReviewed(file)
          return (
            <div key={file.path} className={`rf ${file.path === current!.path ? 'sel' : ''}`} role="listitem">
              <button className={`chk ${done ? 'on' : ''}`} role="checkbox" aria-checked={done} aria-label={`${file.path} reviewed`} onClick={() => { if (!done) void actions.keepFile(file.path); reviewed.toggle(file) }}>
                {done && <Check size={11} strokeWidth={3} />}
              </button>
              <button className="rf-open" onClick={() => setReviewFile(file.path)} title={file.path} aria-current={file.path === current!.path ? 'true' : undefined}>
                <Icon size={15} />
                <span className="rf-path"><span className="dir">{path.dir}</span>{path.name}</span>
                {file.status === 'added' && <span className="tag tag--new">New</span>}
                {file.status === 'deleted' && <span className="tag tag--del">Deleted</span>}
                <Stat added={file.added} removed={file.removed} />
                  <FileRowExtras file={file} />
              </button>
              <button className="rf-undo" onClick={() => void revert([file.path])} disabled={locked || working} aria-label={`Undo changes to ${file.path}`} title={working ? 'Stop the running turn first' : 'Undo this file'}>
                <Undo2 size={14} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="dv-h">
        <span className="fp" title={current!.path}><span className="dir">{dir}</span>{name}</span>
        <span className="when">
          {current!.externallyModified ? 'Changed outside Cubex since' : 'Edited by Cubex'} {relativeTime(current!.updatedAt)}
        </span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Diff layout">
          <button className={`seg__btn ${mode === 'unified' ? 'seg__btn--on' : ''}`} aria-pressed={mode === 'unified'} onClick={() => chooseMode('unified')}>Unified</button>
          <button className={`seg__btn ${mode === 'split' ? 'seg__btn--on' : ''}`} aria-pressed={mode === 'split'} onClick={() => chooseMode('split')}>Split</button>
        </div>
      </div>

      {conversationId && <ReviewProblems conversationId={conversationId} file={current!} />}

      <div className="dv-scroll">
        {conversationId && <FileReview file={current!} review={review} conversationId={conversationId} mode={mode} working={working} busy={locked} actions={actions} />}
      </div>

      {conversationId && <CommentTray conversationId={conversationId} working={working} onOpenFile={setReviewFile} />}

      <footer className="rev-f">
        {done ? (
          <span className="rev-f__done" role="status">
            <Check size={14} />
            Committed <code>{done.commit}</code>
            <span className="rev-f__subject">{done.subject}</span>
          </span>
        ) : (
          <>
            <Eye size={14} />
            {reviewed.count} of {files.length} {files.length === 1 ? 'file' : 'files'} reviewed
          </>
        )}
        <span className="grow" />
        {git?.isRepo ? (
          <button
            className={`btn sm ${committing ? 'is-open' : 'pri'}`}
            onClick={() => setCommitting((open) => !open)}
            disabled={working || nothingToCommit}
            aria-expanded={committing}
            title={working ? 'Commit when the turn has finished' : nothingToCommit ? 'Everything is committed' : `Commit changes to ${branchLabel}`}
          >
            <GitCommitHorizontal size={14} />Commit
          </button>
        ) : (
          <span className="rev-f__hint">Undo restores a file to how it was before this session</span>
        )}
      </footer>

      {committing && git?.isRepo && conversationId && (
        <CommitSheet
          conversationId={conversationId}
          branch={branchLabel}
          files={files}
          initial={defaultPicks(files, committed.has, reviewed)}
          isCommitted={committed.has}
          onClose={() => setCommitting(false)}
          onCommitted={(result) => {
            setCommitting(false)
            setDone(result)
            committed.add(result.files)
            reviewed.markAll(result.files)
            changes.refresh()
          }}
        />
      )}
    </>
  )
}

function NoticeBar({ notice, onClose, onUndo }: { notice: Notice; onClose: () => void; onUndo?: () => void }): JSX.Element {
  return (
    <div className={`rev-notice rev-notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div>
        <p>{notice.text}</p>
        {notice.details?.map((detail) => <p className="rev-notice__detail" key={detail}>{detail}</p>)}
      </div>
      {onUndo && notice.undo && <span className="rev-notice__acts"><button type="button" className="rev-notice__act" onClick={onUndo}>{notice.undo.label}</button></span>}
      <button onClick={onClose} aria-label="Dismiss"><X size={14} /></button>
    </div>
  )
}
