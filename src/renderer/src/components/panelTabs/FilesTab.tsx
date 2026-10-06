import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import type { DirEntry } from '../../../../shared/ipc'
import { useChanges } from '../../lib/useSessionChanges'
import { useStore } from '../../state/store'
import { useFiles } from '../../state/files'
import { FileTree } from '../files/FileTree'
import { EmptyPreview, FilePreview } from '../files/FilePreview'
import { SearchResults, hasResultList, resultId, useFileSearch } from '../files/FileSearch'
import type { PanelTabDef } from './registry'
import '../files/files.css'

/** Whether the open task has a folder to browse. */
function useHasWorkspace(): boolean {
  return useStore((state) => !!(state.activeConversation ? state.activeConversation.workspacePath : state.settings?.general.workspacePath))
}

function FilesTab(): JSX.Element {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const workspace = useStore((state) => (state.activeConversation ? state.activeConversation.workspacePath : state.settings?.general.workspacePath))
  const owner = `${conversationId ?? ''}|${workspace ?? ''}`
  const pickWorkspace = useStore((state) => state.pickWorkspace)
  const { changes } = useChanges()
  const pane = useFiles((state) => state.pane)
  const selected = useFiles((state) => state.selected)
  const showHidden = useFiles((state) => state.showHidden)
  const setShowHidden = useFiles((state) => state.setShowHidden)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searching = query.trim().length > 0
  const search = useFileSearch(query, conversationId, showHidden)
  const listed = searching && hasResultList(search)

  // A different task has different files: start over, and list its top level.
  useEffect(() => {
    if (!workspace) return
    const files = useFiles.getState()
    files.bind({ owner, conversationId })
    setQuery('')
    files.refresh()
  }, [owner, conversationId, workspace])

  // The agent adds, edits and removes files while the tab is open.
  const changeKey = useMemo(() => changes.files.map((file) => `${file.path}@${file.updatedAt}`).join('|'), [changes.files])
  useEffect(() => {
    if (workspace) useFiles.getState().refresh()
  }, [changeKey, workspace])

  const changed = useMemo(() => new Map(changes.files.map((file) => [file.path, file])), [changes.files])
  useEffect(() => setActive(0), [search.results])

  if (!workspace) {
    return (
      <div className="rev-empty">
        <FolderOpen size={22} strokeWidth={1.5} aria-hidden="true" />
        <h2>No project folder</h2>
        <p>Choose a folder and its files will show up here, with a reader for each one.</p>
        <button type="button" className="btn sm" onClick={() => void pickWorkspace()}>Choose folder</button>
      </div>
    )
  }

  const open = (entry: DirEntry): void => {
    void useFiles.getState().select(entry.path)
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      setQuery('')
    } else if (searching && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && search.results.length) {
      event.preventDefault()
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + search.results.length) % search.results.length)
    } else if (searching && event.key === 'Enter') {
      const entry = search.results[active]
      if (entry) {
        event.preventDefault()
        open(entry)
      }
    }
  }

  return (
    <div className="fx">
      <div className="fx-body" data-pane={pane}>
        <section className="fx-nav" aria-label="Project files">
          <div className="fx-bar">
            <div className="fx-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="input"
                type="text"
                role="combobox"
                aria-label="Search files"
                aria-expanded={listed}
                aria-controls={listed ? 'fx-results' : undefined}
                aria-activedescendant={searching && search.results.length ? resultId(active) : undefined}
                placeholder="Search files"
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKey}
              />
              {query && <button type="button" className="fx-search__clear" onClick={() => setQuery('')} aria-label="Clear search" title="Clear search"><X size={14} /></button>}
            </div>
          </div>
          {searching
            ? <SearchResults query={query} search={search} active={active} onActive={setActive} onPick={open} />
            : <FileTree changes={changed} />}
          <div className="fx-foot">
            <label className="fx-toggle">
              <button type="button" role="switch" aria-checked={showHidden} className={`switch ${showHidden ? 'switch--on' : ''}`} onClick={() => setShowHidden(!showHidden)} />
              <span>Show hidden and ignored</span>
            </label>
            <span className="grow" />
            <button type="button" className="ib fx-refresh" onClick={() => useFiles.getState().refresh()} aria-label="Refresh files" title="Refresh files"><RefreshCw size={14} /></button>
          </div>
        </section>
        <section className="fx-view" aria-label="File preview">
          {selected
            ? <FilePreview key={selected} path={selected} version={changes.files.find((file) => file.path === selected)?.updatedAt.toString() ?? ''} onBack={() => useFiles.setState({ pane: 'tree' })} />
            : <EmptyPreview />}
        </section>
      </div>
    </div>
  )
}

export const tab: PanelTabDef = { id: 'files', label: 'Files', order: 20, Component: FilesTab, useVisible: useHasWorkspace }
