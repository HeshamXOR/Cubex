import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, GitBranch, GitCommitHorizontal, Minus, X } from 'lucide-react'
import { api } from '../lib/api'
import { plural, splitPath } from '../lib/format'
import { displayOutput } from '../lib/terminalText'
import { refreshGitStatus } from '../lib/useGitStatus'
import type { SessionFileChange } from '../../../shared/ipc'
import { Stat } from './ChangeStat'
import './commit.css'

/** What a finished commit reports back to the review panel. */
export interface CommitDone {
  commit: string
  subject: string
  /** The change count git printed, such as "3 files changed, 55 insertions(+), 3 deletions(-)". */
  counts: string
  files: SessionFileChange[]
}

const MAX_PATHS = 200
const MAX_MESSAGE = 2000
const MAX_LOG_LINES = 12
const MAX_FIRST_LINE = 72

/** Text typed but not committed survives closing the sheet and switching tabs, per conversation. */
const drafts = new Map<string, string>()

/** A failure as a headline plus, for hook output, the lines under it. */
function describeFailure(error: string): { head: string; log: string[] } {
  const lines = displayOutput(error).split('\n').map((line) => line.trimEnd())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const [head = 'The commit failed.', ...rest] = lines
  while (rest.length && !rest[0]) rest.shift()
  const log = rest.length > MAX_LOG_LINES ? [...rest.slice(0, MAX_LOG_LINES), `${rest.length - MAX_LOG_LINES} more lines`] : rest
  return { head, log }
}

interface CommitSheetProps {
  conversationId: string
  /** Where the commit lands: a branch name, or how HEAD is detached. */
  branch: string
  files: readonly SessionFileChange[]
  /** Paths ticked when the sheet opens. */
  initial: readonly string[]
  isCommitted: (file: SessionFileChange) => boolean
  onClose: () => void
  onCommitted: (done: CommitDone) => void
}

/** Writes the message, picks the files and commits them. Never pushes. */
export function CommitSheet({ conversationId, branch, files, initial, isCommitted, onClose, onCommitted }: CommitSheetProps): JSX.Element {
  const kept = useRef(drafts.get(conversationId))
  const [message, setMessage] = useState(kept.current ?? '')
  const [suggesting, setSuggesting] = useState(kept.current === undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const typed = useRef(kept.current !== undefined)
  const latest = useRef(message)
  const finished = useRef(false)
  const alive = useRef(true)
  const area = useRef<HTMLTextAreaElement>(null)
  latest.current = message

  // Offer a message unless one was kept or the person has already started typing.
  useEffect(() => {
    if (kept.current !== undefined) return
    let live = true
    api.gitSuggestMessage(conversationId).then(
      (text) => {
        if (!live) return
        if (text && !typed.current) setMessage(text)
        setSuggesting(false)
      },
      () => { if (live) setSuggesting(false) }
    )
    return () => { live = false }
  }, [conversationId])

  useEffect(() => {
    // StrictMode mounts, cleans up and mounts again, so the flag is set here and not only initialised.
    alive.current = true
    area.current?.focus()
    return () => {
      alive.current = false
      if (!finished.current && typed.current && latest.current.trim()) drafts.set(conversationId, latest.current)
      else drafts.delete(conversationId)
    }
  }, [conversationId])

  // Grow with the text from two lines to six, then scroll.
  useLayoutEffect(() => {
    const field = area.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight + (field.offsetHeight - field.clientHeight)}px`
  }, [message])

  const selected = files.filter((file) => picked.has(file.path))
  const everyone = files.length > 0 && selected.length === files.length
  const firstLine = message.split('\n')[0] ?? ''
  const tooMany = selected.length > MAX_PATHS
  const ready = !busy && !!message.trim() && selected.length > 0 && !tooMany
  const failure = error ? describeFailure(error) : undefined
  const added = selected.reduce((sum, file) => sum + file.added, 0)
  const removed = selected.reduce((sum, file) => sum + file.removed, 0)

  const toggle = (path: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }
  const toggleAll = (): void => setPicked(everyone ? new Set() : new Set(files.map((file) => file.path)))
  const close = (): void => { if (!busy) onClose() }

  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.gitCommit(conversationId, { message: message.trim(), paths: selected.map((file) => file.path) })
      if (result.ok) {
        finished.current = true
        refreshGitStatus()
        if (!alive.current) return
        const [subject = '', ...rest] = result.summary.split('\n')
        onCommitted({ commit: result.commit, subject, counts: rest.join(' ').trim(), files: selected })
        return
      }
      if (alive.current) setError(result.error)
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'The commit failed.')
    }
    if (alive.current) setBusy(false)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Esc closes the sheet, not the running turn behind it.
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <section className="commit" role="group" aria-label="Commit changes" onKeyDown={onKeyDown}>
      <header className="commit__h">
        <GitCommitHorizontal size={15} aria-hidden="true" />
        <h3>Commit</h3>
        <span className="commit__branch" title={`Commits to ${branch}`}><GitBranch size={12} aria-hidden="true" /><span>{branch}</span></span>
        <span className="grow" />
        <button className="ib" onClick={close} disabled={busy} aria-label="Close" title="Close"><X size={15} /></button>
      </header>

      <div className="commit__msg-wrap">
        <textarea
          ref={area}
          className="commit__msg"
          value={message}
          rows={2}
          maxLength={MAX_MESSAGE}
          readOnly={busy}
          spellCheck
          placeholder={suggesting ? 'Writing a message…' : 'Describe what changed'}
          aria-label="Commit message"
          aria-busy={suggesting}
          onChange={(event) => { typed.current = true; setMessage(event.target.value) }}
        />
        {firstLine.length > MAX_FIRST_LINE && (
          <p className="commit__note">The first line is {firstLine.length} characters. Git log reads best at {MAX_FIRST_LINE} or fewer.</p>
        )}
      </div>

      <div className="commit__files">
        <div className="commit__fh">
          <button
            className={`chk ${everyone ? 'on' : selected.length ? 'part' : ''}`}
            role="checkbox"
            aria-checked={everyone ? true : selected.length ? 'mixed' : false}
            aria-label="Select all files"
            onClick={toggleAll}
          >
            {everyone ? <Check size={11} strokeWidth={3} /> : selected.length ? <Minus size={11} strokeWidth={3} /> : null}
          </button>
          <span>{selected.length} of {plural(files.length, 'file')} selected</span>
          <span className="grow" />
          <Stat added={added} removed={removed} />
        </div>
        <div className="commit__list" role="group" aria-label="Files to commit">
          {files.map((file) => {
            const on = picked.has(file.path)
            const path = splitPath(file.path)
            return (
              <button key={file.path} className="commit__row" role="checkbox" aria-checked={on} onClick={() => toggle(file.path)} title={file.path}>
                <span className={`chk ${on ? 'on' : ''}`} aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>
                <span className="rf-path"><span className="dir">{path.dir}</span>{path.name}</span>
                {file.status === 'added' && <span className="tag tag--new">New</span>}
                {file.status === 'deleted' && <span className="tag tag--del">Deleted</span>}
                {isCommitted(file) && <span className="tag tag--done">Committed</span>}
                <Stat added={file.added} removed={file.removed} />
              </button>
            )
          })}
        </div>
      </div>

      {failure && (
        <div className="commit__err" role="alert">
          <p>{failure.head}</p>
          {failure.log.length > 0 && <pre>{failure.log.join('\n')}</pre>}
        </div>
      )}

      <footer className="commit__a">
        <span className="commit__hint">
          {tooMany ? `Select ${MAX_PATHS} files or fewer` : <><kbd>Ctrl Enter</kbd> to commit</>}
        </span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn sm pri" onClick={() => void submit()} disabled={!ready}>
          {busy ? 'Committing…' : selected.length ? `Commit ${plural(selected.length, 'file')}` : 'Commit'}
        </button>
      </footer>
    </section>
  )
}
