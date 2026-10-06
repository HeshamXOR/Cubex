import { memo, useState } from 'react'
import { BookOpen, FileText, Pencil, Trash2 } from 'lucide-react'
import { useStore, type LiveMessage } from '../../state/store'
import { useRestore } from '../../state/restore'
import { useBusy } from '../../lib/useBusy'
import { useSkillInvocation } from '../../lib/useSkillCatalog'
import { RestoreMenu } from './RestoreMenu'
import './skillchip.css'

/**
 * Edit, Delete and Restore for one of your messages. Each button decides for itself whether a turn is running,
 * so the row does not re-render when one starts or ends.
 */
function UserTools({ messageId, onEdit }: { messageId: string; onEdit: () => void }): JSX.Element {
  const busy = useBusy()
  const deleteMessage = useStore((s) => s.deleteMessage)
  const summarizing = useStore((s) => s.compactingId !== undefined)
  const restoring = useRestore((s) => s.restoring)
  const blockedReason = restoring ? 'Wait for the restore to finish.'
    : busy ? 'Stop the current turn to restore an earlier point.'
      : summarizing ? 'Wait for the summary to finish, then restore.' : undefined
  return (
    <div className="msg-tools msg-tools--user">
      <button className="msg-tool" disabled={busy} title={busy ? 'Stop the current turn to edit' : 'Edit and resend'} onClick={onEdit}><Pencil size={12.5} />Edit</button>
      <button className="msg-tool" disabled={busy} onClick={() => void deleteMessage(messageId)}><Trash2 size={12.5} />Delete</button>
      <RestoreMenu messageId={messageId} blockedReason={blockedReason} />
    </div>
  )
}

interface UserRowProps {
  message: LiveMessage
  /** Above the context divider: still shown, but the model no longer sees it. */
  outside: boolean
}

/**
 * What you wrote starting with a slash. When it names a skill, the skill is a chip and the bubble shows the rest as
 * what you asked of it. It is its own component so that only such a message watches the list of skills.
 */
function SlashText({ text }: { text: string }): JSX.Element {
  const invocation = useSkillInvocation(text)
  if (!invocation) return <p>{text}</p>
  return (
    <>
      <div className="u-atts u-atts--skill">
        <span className="u-att-file u-skill" title="Skill applied to this message"><BookOpen size={13} aria-hidden="true" />{invocation.skill}</span>
      </div>
      {invocation.request && <p>{invocation.request}</p>}
    </>
  )
}

/**
 * One of your messages in the thread. Memoized like the assistant rows, and the text being edited lives here,
 * so typing in the edit box re-renders this row and no other.
 */
export const UserRow = memo(function UserRow({ message: m, outside }: UserRowProps): JSX.Element {
  const editUserMessage = useStore((s) => s.editUserMessage)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const startEdit = (): void => {
    setEditText(m.text)
    setEditing(true)
  }
  const cancelEdit = (): void => {
    setEditing(false)
    setEditText('')
  }
  const saveEdit = (): void => {
    const next = editText.trim()
    cancelEdit()
    if (next) void editUserMessage(m.id, next)
  }

  return (
    <div className={`u${outside ? ' is-outside' : ''}`} data-message="user">
      {editing ? (
        <div className="u-edit">
          <textarea
            value={editText}
            autoFocus
            rows={Math.min(8, editText.split('\n').length + 1)}
            aria-label="Edit message"
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveEdit() }
              if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
            }}
          />
          <div className="u-edit__row">
            <button className="btn ghost sm" onClick={cancelEdit}>Cancel</button>
            <button className="btn pri sm" onClick={saveEdit} disabled={!editText.trim()}>Send</button>
          </div>
        </div>
      ) : (
        <div className="u-wrap">
          <div className="u-bubble">
            {m.attachments && m.attachments.length > 0 && (
              <div className="u-atts">
                {m.attachments.map((a, i) =>
                  a.type === 'image' && a.source.kind === 'base64' ? (
                    <img key={i} className="u-att-img" src={`data:${a.source.mediaType};base64,${a.source.data}`} alt="attachment" />
                  ) : (
                    <span key={i} className="u-att-file"><FileText size={13} />{a.type === 'file' ? a.filename ?? 'file' : a.type}</span>
                  )
                )}
              </div>
            )}
            {m.text && (m.text.startsWith('/') ? <SlashText text={m.text} /> : <p>{m.text}</p>)}
          </div>
          {!m.streaming && <UserTools messageId={m.id} onEdit={startEdit} />}
        </div>
      )}
    </div>
  )
})
