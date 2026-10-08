import { useId, useState } from 'react'
import { BookOpen, Boxes, Check, ChevronRight, Contrast, FileText, FolderTree, Globe, MessagesSquare, Search, Telescope, Terminal, Wrench, X } from 'lucide-react'
import type { ToolActivity } from '../../../shared/ipc'
import { PEER_VERDICT_LABEL, type PeerVerdict } from '../../../shared/peers'
import { formatSeconds } from '../lib/format'
import { fromSubagent as isFromSubagent, toolKind, toolTarget } from '../lib/transcriptGroups'
import { ActivityGlyph, type ActivityGlyphKind } from '../theme/StateIcons'
import { CommandOutputPanel } from './CommandOutputPanel'
import { Markdown } from './Markdown'
import { PathLink } from './PathLink'
import './toolcard.css'

const ICON: Record<string, JSX.Element> = {
  read_file: <FileText size={15} strokeWidth={1.65} />,
  list_files: <FolderTree size={15} strokeWidth={1.65} />,
  search_files: <Search size={15} strokeWidth={1.65} />,
  glob_files: <FolderTree size={15} strokeWidth={1.65} />,
  run_command: <Terminal size={15} strokeWidth={1.65} />,
  read_command_output: <Terminal size={15} strokeWidth={1.65} />,
  web_fetch: <Globe size={15} strokeWidth={1.65} />,
  web_search: <Telescope size={15} strokeWidth={1.65} />,
  skill: <BookOpen size={15} strokeWidth={1.65} />,
  delegate_to_subagent: <Boxes size={15} strokeWidth={1.65} />,
  consult_agent: <MessagesSquare size={15} strokeWidth={1.65} />
}
const GLYPH: Record<string, ActivityGlyphKind> = {
  write_file: 'editing', edit_file: 'editing', remove_file: 'removing', delete_file: 'removing',
  exit_plan_mode: 'planning', read_plan: 'planning', ask_user_question: 'waiting',
  run_command: 'running', read_command_output: 'running'
}
/** The calls whose target is a file or folder of the project. */
const LINKED_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_files'])

const VERDICT_ICON: Record<PeerVerdict, JSX.Element> = {
  agree: <Check size={12} strokeWidth={2} aria-hidden="true" />,
  partly: <Contrast size={12} strokeWidth={2} aria-hidden="true" />,
  disagree: <X size={12} strokeWidth={2} aria-hidden="true" />
}

/** How long another agent took, for the card of a finished consultation: "41s", "2m 5s". */
const took = (seconds: number): string => formatSeconds(seconds * 1000)

/** A compact operation row with its actual phase and optional result or diff. */
export function ToolCard({ tool, waitingForInput = false }: { tool: ToolActivity; waitingForInput?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [outputOpen, setOutputOpen] = useState(false)
  const id = useId()
  const waiting = tool.phase === 'running' && waitingForInput
  const running = tool.phase === 'running' && !waiting
  const error = tool.phase === 'error'
  const queued = tool.phase === 'queued'
  const kind = toolKind(tool.name)
  const glyph = GLYPH[tool.name]
  const fromSubagent = isFromSubagent(tool)
  const target = toolTarget(tool)
  const hasOutput = !!(tool.outputId && tool.outputConversationId)
  const hasDetails = !!(tool.diff || tool.detail || hasOutput)
  const phase = tool.interrupted ? 'Interrupted' : error ? 'Failed' : waiting ? 'Waiting for you' : running ? 'Running' : queued ? 'Queued' : 'Completed'
  const removing = glyph === 'removing'
  // A row with nothing to expand is plain text, so the file or folder it names can be a link. A button cannot hold one.
  const linkable = !hasDetails && !!target && LINKED_TOOLS.has(tool.name)

  const summary = (
    <>
      <span className="toolrow__icon">
        {waiting ? <ActivityGlyph kind="waiting" size={15} />
          : running ? <ActivityGlyph kind="thinking" size={14} active />
          : glyph ? <ActivityGlyph kind={glyph} size={15} />
          : ICON[tool.name] ?? <Wrench size={15} strokeWidth={1.65} />}
      </span>
      <span className="toolrow__kind">{kind}</span>{' '}
      {target && <span className={linkable ? 'toolrow__target toolrow__target--link' : 'toolrow__target'} title={target}>{linkable ? <PathLink text={target} className="pathlink--clip">{target}</PathLink> : target}</span>}{' '}
      {fromSubagent && tool.name !== 'delegate_to_subagent' && <span className="toolrow__origin">Subagent</span>}
      {tool.peer && (
        <span className="toolrow__peer">
          <span className="toolrow__meta">Round {tool.peer.round} of {tool.peer.of}{tool.peer.seconds !== undefined ? `, ${took(tool.peer.seconds)}` : ''}</span>
          {tool.peer.verdict && <span className={`toolrow__verdict toolrow__verdict--${tool.peer.verdict}`}>{VERDICT_ICON[tool.peer.verdict]}{PEER_VERDICT_LABEL[tool.peer.verdict]}</span>}
        </span>
      )}
      {(!!tool.added || !!tool.removed) && <span className="toolrow__diff" aria-label={`${tool.added ?? 0} lines added, ${tool.removed ?? 0} removed`}>
        {!!tool.added && <span className="diff-add">+{tool.added}</span>}
        {!!tool.removed && <span className="diff-del">−{tool.removed}</span>}
      </span>}
      {(running || waiting || error || queued)
        ? <span className={`toolrow__phase ${error && !tool.interrupted ? 'toolrow__phase--error' : ''} ${waiting ? 'toolrow__phase--waiting' : ''}`}>{phase}</span>
        : <span className="sr-only">{phase}</span>}
      {hasDetails && <ChevronRight size={14} className={`toolrow__chev ${open ? 'is-open' : ''}`} aria-hidden="true" />}
    </>
  )

  return (
    <div className={`toolrow ${removing ? 'toolrow--removing' : ''}`} data-phase={tool.interrupted ? 'interrupted' : waiting ? 'waiting' : tool.phase} data-tool={tool.name}>
      {linkable
        ? <div className="toolrow__summary toolrow__summary--static">{summary}</div>
        : <button className="toolrow__summary" onClick={() => hasDetails && setOpen(value => !value)} disabled={!hasDetails} aria-expanded={hasDetails ? open : undefined} aria-controls={hasDetails ? id : undefined}>{summary}</button>}
      {open && tool.diff ? <div id={id} className="toolrow__diffview" role="region" aria-label={`${kind} changes`}>
        {tool.diff.split('\n').map((line, index) => {
          const tag = line[0]
          const change = tag === '+' || tag === '-'
          const content = change || tag === ' ' ? line.slice(1) : line
          const cls = tag === '+' ? 'tdl tdl--add' : tag === '-' ? 'tdl tdl--del' : tag === '@' ? 'tdl tdl--gap' : 'tdl'
          return <div className={cls} key={index}><span className="tdl__tag" aria-hidden="true">{change ? tag : ''}</span><span>{content || '\u00a0'}</span></div>
        })}
      </div> : open && tool.peer && tool.detail ? <div id={id} className="toolrow__reply" role="region" aria-label={`${tool.peer.name} replied`}>
        {tool.peer.asked && <><div className="toolrow__label">Sent</div><div className="toolrow__quote">{tool.peer.asked}</div></>}
        <div className="toolrow__label">{tool.peer.name} replied</div>
        <div className="prose"><Markdown text={tool.detail} /></div>
      </div>
        : open && (tool.detail || hasOutput) && <div id={id} className="toolrow__body">{tool.detail || 'Command output saved.'}</div>}
      {open && hasOutput && <button className="toolrow__output" onClick={() => setOutputOpen(true)}><Terminal size={14} />View saved output<ChevronRight size={13} /></button>}
      {outputOpen && hasOutput && <CommandOutputPanel key={`${tool.outputConversationId}:${tool.outputId}`} conversationId={tool.outputConversationId!} outputId={tool.outputId!} onClose={() => setOutputOpen(false)} />}
    </div>
  )
}
