import { useEffect, useRef } from 'react'
import { isMac } from '../lib/shortcuts'
import { COMMENT_MAX_LENGTH } from '../state/reviewComments'

/** The key that adds the comment, named the way this machine prints it (the shortcut sheet says the same). */
const SUBMIT_KEYS = `${isMac ? 'Cmd' : 'Ctrl'}+Enter`

interface Props {
  /** What the comment is about, as in the middle of a sentence: "lines 12 to 18". */
  where: string
  text: string
  onChange: (text: string) => void
  /** "Add comment" for a new comment, "Save" for one being changed. */
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
}

/**
 * The editor under a hunk where a comment is written. Ctrl+Enter adds it and Esc drops it. It takes focus when it opens
 * and gives focus back to what had it when it closes.
 */
export function CommentEditor({ where, text, onChange, submitLabel, onSubmit, onCancel }: Props): JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  const ready = text.trim().length > 0

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const element = field.current
    element?.focus()
    element?.setSelectionRange(element.value.length, element.value.length)
    return () => {
      if (before?.isConnected && (document.activeElement === element || document.activeElement === document.body)) before.focus()
    }
  }, [])

  return (
    <div className="cmt-edit">
      <textarea
        ref={field}
        className="textarea cmt-edit__field"
        aria-label={`Comment on ${where}`}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        placeholder="Tell Cubex what to change here"
        rows={3}
        maxLength={COMMENT_MAX_LENGTH}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && ready) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <div className="cmt-edit__bar">
        <span className="cmt-edit__hint">{SUBMIT_KEYS} to {submitLabel === 'Save' ? 'save' : 'add'}, Esc to cancel</span>
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn pri sm" disabled={!ready} onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  )
}
