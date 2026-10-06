import { useEffect, useId, useRef, useState } from 'react'

/** Desktop-safe editing: Electron does not implement window.prompt. */
export function InlineRename({ value, onSave, onClose }: {
  value: string
  onSave: (title: string) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const closed = useRef(false)
  const errorId = useId()

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const close = (): void => {
    closed.current = true
    onClose()
  }

  const commit = async (): Promise<void> => {
    if (pending.current || closed.current) return
    const title = draft.trim()
    if (!title || title === value) { close(); return }
    pending.current = true
    setSaving(true)
    setError('')
    try {
      await onSave(title)
      close()
    } catch {
      setError('Could not save the name. Press Enter to try again, or Escape to cancel.')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return (
    <span className="inline-rename" title={error || 'Press Enter to save or Escape to cancel'}>
      <input
        ref={input}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setError('') }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          if (event.key === 'Enter') { event.preventDefault(); void commit() }
        }}
        aria-label="Conversation name"
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        aria-busy={saving}
        readOnly={saving}
        maxLength={200}
      />
      {error && <span id={errorId} role="alert" className="inline-rename__error">{error}</span>}
    </span>
  )
}
