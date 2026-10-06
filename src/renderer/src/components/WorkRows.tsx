import { useState } from 'react'
import { ChevronRight, FileDiff, FilePlus, FileX, Globe, Pencil, Search, ShieldQuestion, Telescope } from 'lucide-react'
import type { ToolActivity } from '../../../shared/ipc'
import { useStore } from '../state/store'
import { basename, plural, splitPath } from '../lib/format'
import { exploreSummary, groupPhase, toolTarget, type EditedFile } from '../lib/transcriptGroups'
import { ActivityGlyph } from '../theme/StateIcons'
import { FileProblems } from './FileProblems'
import { ProblemsChip } from './ProblemsChip'
import { ToolCard } from './ToolCard'

/** The still icon for a kind of work, or the turning star while it runs. */
function Lead({ running, children }: { running: boolean; children: JSX.Element }): JSX.Element {
  return running ? <ActivityGlyph kind="thinking" size={14} active className="wrow__lead" /> : children
}

function Stat({ added, removed }: { added: number; removed: number }): JSX.Element | null {
  if (!added && !removed) return null
  return (
    <span className="stat" aria-label={`${added} lines added, ${removed} removed`}>
      {added > 0 && <span className="p">+{added}</span>}
      {removed > 0 && <span className="m">−{removed}</span>}
    </span>
  )
}

interface GroupProps {
  tools: ToolActivity[]
  /** The call that is waiting for the person, when it is in this group. */
  waitingId?: string
}

function ChildRows({ tools, waitingId }: GroupProps): JSX.Element {
  return (
    <div className="files">
      {tools.map((tool) => <ToolCard key={tool.id} tool={tool} waitingForInput={tool.id === waitingId} />)}
    </div>
  )
}

/** Reads, searches and listings, folded into one quiet row that opens to the individual calls. */
export function ExploreGroup({ tools, waitingId }: GroupProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const phase = groupPhase(tools)
  const running = phase === 'running' || phase === 'queued'
  const summary = exploreSummary(tools)
  const parts = [
    summary.files.length ? plural(summary.files.length, 'file') : '',
    summary.searches ? plural(summary.searches, 'search', 'searches') : '',
    summary.folders ? plural(summary.folders, 'folder') : ''
  ].filter(Boolean)
  return (
    <div className="work" data-phase={phase}>
      <button className="wrow" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Lead running={running}><Search size={15} /></Lead>
        <span>{running ? 'Exploring' : 'Explored'}</span>
        <b>{parts.join(', ')}</b>
        {!open && summary.files.length > 0 && <span className="sub">{summary.files.map(basename).join(', ')}</span>}
        {phase === 'error' && <span className="wrow__state wrow__state--error">Some failed</span>}
        <ChevronRight size={13} className={`wrow__chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && <ChildRows tools={tools} waitingId={waitingId} />}
    </div>
  )
}

/** Searches and page fetches, as one row. */
export function WebGroup({ tools, waitingId }: GroupProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const phase = groupPhase(tools)
  const running = phase === 'running' || phase === 'queued'
  const searches = tools.filter((tool) => tool.name === 'web_search')
  const pages = tools.filter((tool) => tool.name === 'web_fetch')
  const parts = [
    searches.length ? plural(searches.length, 'search', 'searches') : '',
    pages.length ? plural(pages.length, 'page') : ''
  ].filter(Boolean)
  const first = toolTarget(tools[0]!)
  return (
    <div className="work" data-phase={phase}>
      <button className="wrow" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Lead running={running}>{searches.length ? <Telescope size={15} /> : <Globe size={15} />}</Lead>
        <span>{running ? 'Browsing' : 'Browsed'}</span>
        <b>{parts.join(', ')}</b>
        {!open && first && <span className="sub">{first}</span>}
        {phase === 'error' && <span className="wrow__state wrow__state--error">Some failed</span>}
        <ChevronRight size={13} className={`wrow__chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && <ChildRows tools={tools} waitingId={waitingId} />}
    </div>
  )
}

function FileRow({ file, selected, waiting, onOpen }: { file: EditedFile; selected: boolean; waiting: boolean; onOpen: (path: string) => void }): JSX.Element {
  const { dir, name } = splitPath(file.path)
  const running = !waiting && (file.phase === 'running' || file.phase === 'queued')
  const Icon = file.status === 'added' ? FilePlus : file.status === 'deleted' ? FileX : FileDiff
  return (
    <FileProblems diagnostics={file.diagnostics}>
      <button className={`file ${selected ? 'sel' : ''}`} onClick={() => onOpen(file.path)} title={`Review changes to ${file.path}`} data-phase={waiting ? 'waiting' : file.phase}>
        {waiting ? <ShieldQuestion size={15} className="wrow__wait" aria-hidden="true" /> : <Lead running={running}><Icon size={15} /></Lead>}
        <span className="file__path"><span className="dir">{dir}</span>{name}</span>
        {waiting && <span className="wrow__state wrow__state--wait">Waiting for you</span>}
        {file.phase === 'error' && <span className="wrow__state wrow__state--error">Failed</span>}
        {file.diagnostics && <ProblemsChip errors={file.diagnostics.errors} warnings={file.diagnostics.warnings} title="Introduced by this edit" />}
        <Stat added={file.added} removed={file.removed} />
      </button>
    </FileProblems>
  )
}

/** Files a run of edits touched. Opening a file shows its diff in the review panel. */
export function EditGroup({ files, tools, waitingId }: { files: EditedFile[]; tools: ToolActivity[]; waitingId?: string }): JSX.Element {
  const openReview = useStore((s) => s.openReview)
  const reviewFile = useStore((s) => (s.panelOpen && s.panelTab === 'changes' ? s.reviewFile : undefined))
  const phase = groupPhase(tools)
  const running = phase === 'running' || phase === 'queued'
  const isWaiting = (file: EditedFile): boolean => !!waitingId && file.ids.includes(waitingId)
  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)

  if (files.length === 1) {
    return (
      <div className="work work--edit" data-phase={phase}>
        <FileRow file={files[0]!} selected={reviewFile === files[0]!.path} waiting={isWaiting(files[0]!)} onOpen={openReview} />
      </div>
    )
  }
  return (
    <div className="work work--edit" data-phase={phase}>
      <div className="wrow wrow--static">
        <Lead running={running}><Pencil size={15} /></Lead>
        <span>{running ? 'Editing' : 'Edited'}</span>
        <b>{plural(files.length, 'file')}</b>
        <Stat added={added} removed={removed} />
      </div>
      <div className="files">
        {files.map((file) => <FileRow key={file.path} file={file} selected={reviewFile === file.path} waiting={isWaiting(file)} onOpen={openReview} />)}
      </div>
    </div>
  )
}
