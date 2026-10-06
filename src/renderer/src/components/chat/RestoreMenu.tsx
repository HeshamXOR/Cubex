import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { FileCode, History, MessageSquare, RotateCcw } from 'lucide-react'
import type { RestorePreview } from '../../../../shared/ipc'
import { api } from '../../lib/api'
import { splitPath } from '../../lib/format'
import { CHOICES, CHOICE_AXES, CHOICE_LABEL, actionPhrase, describeChoice, type RestoreChoice } from '../../lib/restoreCopy'
import { useMenuKeys } from '../../lib/useMenuKeys'
import { restoreTo } from '../../state/restore'
import { useStore } from '../../state/store'
import './restore.css'

const CHOICE_ICON: Record<RestoreChoice, typeof History> = { both: RotateCcw, conversation: MessageSquare, code: FileCode }
/** What the arrow keys move between: the options, then the two buttons of the confirmation. */
const ENTRIES = '.restore__choice, .restore__actions button'
/** Space kept between the popover and the window edge, and between the popover and its button. */
const EDGE = 8
const GAP = 6
/** Until the popover has been measured it sits in a corner, invisible. It stays focusable, and the measurement happens before the first paint. */
const UNPLACED: CSSProperties = { opacity: 0, top: 0, right: 0 }

function FileList({ label, items }: { label: string; items: { path: string; note?: string }[] }): JSX.Element {
  return (
    <>
      <div className="restore__sub">{label}</div>
      <ul className="restore__files">
        {items.map(({ path, note }) => {
          const { dir, name } = splitPath(path)
          return (
            <li key={path}>
              <span className="restore__path" title={path}>
                <span className="restore__dir">{dir}</span>
                <span className="restore__name">{name}</span>
              </span>
              {note && <span className="restore__how">{note}</span>}
            </li>
          )
        })}
      </ul>
    </>
  )
}

interface RestoreMenuProps {
  messageId: string
  /** Why Restore cannot be used right now. It becomes the button's tooltip. */
  blockedReason?: string
}

/**
 * Go back to before one of your messages. The button opens a popover with three options and what each would
 * change; choosing one shows the files and asks once more before anything is touched.
 */
export function RestoreMenu({ messageId, blockedReason }: RestoreMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<RestoreChoice>()
  const [messageCount, setMessageCount] = useState(0)
  const [preview, setPreview] = useState<RestorePreview>()
  const [checkFailed, setCheckFailed] = useState(false)
  const [place, setPlace] = useState<CSSProperties>()
  const cancelRef = useRef<HTMLButtonElement>(null)
  /** Which look at the files the popover is waiting for, so an answer that arrives after it closed is ignored. */
  const lookup = useRef(0)

  const close = useCallback((): void => {
    lookup.current++
    setOpen(false)
    setChoice(undefined)
  }, [])
  const { triggerRef, menuRef, onKeyDown } = useMenuKeys(open, close, ENTRIES)

  const show = (): void => {
    const { liveMessages, activeConversation } = useStore.getState()
    const index = liveMessages.findIndex((message) => message.id === messageId)
    if (index < 0 || !activeConversation) return
    const mine = ++lookup.current
    setMessageCount(liveMessages.length - index)
    setPreview(undefined)
    setCheckFailed(false)
    setChoice(undefined)
    setPlace(undefined)
    setOpen(true)
    api.previewRestore(activeConversation.id, messageId)
      .then((next) => { if (lookup.current === mine) setPreview(next) })
      .catch(() => { if (lookup.current === mine) setCheckFailed(true) })
  }

  // Below the button when it fits, above when there is more room there. The thread can scroll under a fixed popover, so it closes instead.
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const popover = menuRef.current
    if (!open || !trigger || !popover) return
    const rect = trigger.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - EDGE
    const above = rect.top - EDGE
    const right = Math.max(EDGE, window.innerWidth - rect.right)
    setPlace(popover.offsetHeight <= below || below >= above ? { right, top: rect.bottom + GAP } : { right, bottom: window.innerHeight - rect.top + GAP })
  }, [open, choice, preview, checkFailed, triggerRef, menuRef])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event): void => {
      // Scrolling the file list inside the popover is not the thread moving.
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return
      close()
    }
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('scroll', dismiss, true)
    }
  }, [open, close, menuRef])

  // The confirmation starts on Cancel: Enter held down on the option must not also confirm it.
  useEffect(() => { if (choice) cancelRef.current?.focus() }, [choice])

  const confirm = (): void => {
    if (!choice) return
    close()
    void restoreTo(messageId, CHOICE_AXES[choice])
  }

  const axes = choice ? CHOICE_AXES[choice] : undefined
  const info = choice ? describeChoice(choice, preview, messageCount, checkFailed) : undefined
  const files = axes?.code ? preview?.files ?? [] : []
  const left = axes?.code ? preview?.blocked ?? [] : []

  return (
    <>
      <button
        ref={triggerRef}
        className="msg-tool restore__trigger"
        disabled={!!blockedReason}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={blockedReason ?? 'Go back to before this message'}
        onClick={() => (open ? close() : show())}
      >
        <History size={12.5} />Restore
      </button>
      {open && createPortal(
        <>
          <div className="backdrop" onClick={close} />
          <div ref={menuRef} className="menu restore__pop" role="dialog" aria-label="Restore to before this message" tabIndex={-1} onKeyDown={onKeyDown} style={place ?? UNPLACED}>
            {choice && axes && info ? (
              <div className="restore__confirm">
                <div className="restore__title">{CHOICE_LABEL[choice]}</div>
                <p className="restore__effect">{info.effect}</p>
                {axes.conversation && <p className="restore__effect">This message goes back into the composer, so you can change it and send it again.</p>}
                {files.length > 0 && <FileList label="Files" items={files.map((file) => ({ path: file.path, ...(file.action === 'revert' ? {} : { note: actionPhrase(file.action) }) }))} />}
                {left.length > 0 && <FileList label="Left as they are" items={left.map((file) => ({ path: file.path, note: file.reason }))} />}
                <div className="restore__actions">
                  <button ref={cancelRef} className="btn ghost sm" onClick={close}>Cancel</button>
                  <button className="btn pri sm" disabled={axes.code && !preview} onClick={confirm}>Restore</button>
                </div>
              </div>
            ) : (
              <>
                <div className="menu__label">Restore to before this message</div>
                {CHOICES.map((option) => {
                  const Icon = CHOICE_ICON[option]
                  const line = describeChoice(option, preview, messageCount, checkFailed)
                  return (
                    <button key={option} className="menu__item restore__choice" disabled={!!line.disabled} onClick={() => setChoice(option)}>
                      <Icon size={15} />
                      <span>
                        <span className="menu__t">{CHOICE_LABEL[option]}</span>
                        <span className="menu__s">{line.effect}</span>
                      </span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </>,
        document.body
      )}
    </>
  )
}
