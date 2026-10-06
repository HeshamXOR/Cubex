import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, Folder, FolderPlus, GitBranch, PanelRight, Pencil, Share, X } from 'lucide-react'
import { useStore } from '../../state/store'
import { api } from '../../lib/api'
import { basename } from '../../lib/format'
import { useGitStatus } from '../../lib/useGitStatus'
import { useMenuKeys } from '../../lib/useMenuKeys'
import { useChanges } from '../../lib/useSessionChanges'
import { InlineRename } from '../InlineRename'
import { TasksIndicator } from '../TasksIndicator'

/** The conversation's title, where it lives (branch or folder), and its export and review controls. */
export function ConversationHeader(): JSX.Element {
  const conversation = useStore((s) => s.activeConversation)
  const renameConversation = useStore((s) => s.renameActiveConversation)
  const workspace = useStore((s) => (s.activeConversation ? s.activeConversation.workspacePath : s.settings?.general.workspacePath))
  const panelOpen = useStore((s) => s.panelOpen)
  const togglePanel = useStore((s) => s.togglePanel)
  const pickWorkspace = useStore((s) => s.pickWorkspace)
  const clearWorkspace = useStore((s) => s.clearWorkspace)
  const git = useGitStatus(conversation?.id)
  const { changes } = useChanges()
  const [editing, setEditing] = useState(false)
  const [placeMenu, setPlaceMenu] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [copied, setCopied] = useState<string>()
  const placeKeys = useMenuKeys(placeMenu, () => setPlaceMenu(false))
  const exportKeys = useMenuKeys(exportMenu, () => setExportMenu(false))

  const title = conversation?.title ?? 'New session'
  const count = changes.files.length

  const exportAs = async (format: 'markdown' | 'json'): Promise<void> => {
    setExportMenu(false)
    if (!conversation) return
    try {
      const text = await api.exportConversation(conversation.id, format)
      await navigator.clipboard.writeText(text)
      setCopied(format === 'markdown' ? 'Copied as Markdown' : 'Copied as JSON')
    } catch {
      setCopied('Could not copy the session')
    }
    window.setTimeout(() => setCopied(undefined), 2200)
  }

  return (
    <div className="conv-h">
      {editing && conversation ? (
        <InlineRename value={conversation.title} onSave={(value) => renameConversation(conversation.id, value)} onClose={() => setEditing(false)} />
      ) : (
        <h1 title={title} onDoubleClick={() => conversation && setEditing(true)}>{title}</h1>
      )}
      {conversation && !editing && (
        <button className="ib ib--hover" onClick={() => setEditing(true)} aria-label="Rename session" title="Rename session"><Pencil size={13} /></button>
      )}

      <div className="pos-rel">
        {workspace ? (
          <button ref={placeKeys.triggerRef} className={`chip chip--btn chip--place ${placeMenu ? 'is-open' : ''}`} onClick={() => setPlaceMenu((v) => !v)} aria-haspopup="menu" aria-expanded={placeMenu} title={workspace}>
            {git?.isRepo ? <GitBranch size={13} /> : <Folder size={13} />}
            <span className="chip__name">{git?.isRepo ? git.branch ?? (git.head ? `Detached at ${git.head}` : 'Detached') : basename(workspace)}</span>
            {git?.isRepo && !!git.ahead && <span className="chip__n" title={`${git.ahead} to push`}><ArrowUp size={11} />{git.ahead}</span>}
            {git?.isRepo && !!git.behind && <span className="chip__n" title={`${git.behind} to pull`}><ArrowDown size={11} />{git.behind}</span>}
            {git?.isRepo && !git.changedFilesUnknown && git.changedFiles > 0 && <span className="chip__n" title={`${git.changedFiles} uncommitted ${git.changedFiles === 1 ? 'file' : 'files'}`}>{git.changedFiles}<span className="chip__word">{' changed'}</span></span>}
          </button>
        ) : (
          <button className="chip chip--btn" onClick={() => void pickWorkspace()} title="Choose a project folder for Cubex to read and edit">
            <FolderPlus size={13} /><span>Add a project</span>
          </button>
        )}
        {placeMenu && workspace && (
          <>
            <div className="backdrop" onClick={() => setPlaceMenu(false)} />
            <div ref={placeKeys.menuRef} className="menu" style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 260 }} role="menu" tabIndex={-1} onKeyDown={placeKeys.onKeyDown}>
              <div className="menu__label">Project folder</div>
              <div className="menu__path">{workspace}</div>
              <button className="menu__item" role="menuitem" onClick={() => { void pickWorkspace(); setPlaceMenu(false) }}>
                <FolderPlus size={15} /><span className="menu__t">Change folder…</span>
              </button>
              <button className="menu__item" role="menuitem" onClick={() => { void clearWorkspace(); setPlaceMenu(false) }}>
                <X size={15} /><span className="menu__t">Close project</span>
              </button>
            </div>
          </>
        )}
      </div>

      <TasksIndicator />

      <span className="grow" />
      {copied && <span className="conv-h__note" role="status"><Check size={13} />{copied}</span>}

      <div className="pos-rel">
        <button ref={exportKeys.triggerRef} className={`ib ${exportMenu ? 'on' : ''}`} onClick={() => setExportMenu((v) => !v)} disabled={!conversation} aria-label="Export session" aria-haspopup="menu" aria-expanded={exportMenu} title="Export">
          <Share size={16} />
        </button>
        {exportMenu && (
          <>
            <div className="backdrop" onClick={() => setExportMenu(false)} />
            <div ref={exportKeys.menuRef} className="menu" style={{ top: 'calc(100% + 6px)', right: 0, minWidth: 210 }} role="menu" tabIndex={-1} onKeyDown={exportKeys.onKeyDown}>
              <button className="menu__item" role="menuitem" onClick={() => void exportAs('markdown')}><Copy size={15} /><span className="menu__t">Copy as Markdown</span></button>
              <button className="menu__item" role="menuitem" onClick={() => void exportAs('json')}><Copy size={15} /><span className="menu__t">Copy as JSON</span></button>
            </div>
          </>
        )}
      </div>
      <button className={`ib ${panelOpen ? 'on' : ''}`} onClick={togglePanel} aria-pressed={panelOpen} aria-label={count > 0 ? `Review panel, ${count} changed ${count === 1 ? 'file' : 'files'}` : 'Review panel'} title={panelOpen ? 'Hide review' : 'Show review'}>
        <PanelRight size={16} />
        {count > 0 && <span className="ib__badge">{count}</span>}
      </button>
    </div>
  )
}
