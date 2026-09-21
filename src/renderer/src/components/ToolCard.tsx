import {
  Check,
  FileText,
  FolderTree,
  Loader2,
  PenLine,
  Search,
  TriangleAlert,
  Boxes,
  Wrench
} from 'lucide-react'
import type { ToolActivity } from '../../../shared/ipc'
import './toolcard.css'

const ICON: Record<string, JSX.Element> = {
  read_file: <FileText size={14} />,
  write_file: <PenLine size={14} />,
  list_files: <FolderTree size={14} />,
  search_files: <Search size={14} />,
  delegate_to_subagent: <Boxes size={14} />
}

/**
 * An in-thread card showing one tool the model is running — spinner while
 * active, a check when done, and +added / −removed line badges for edits.
 */
export function ToolCard({ tool }: { tool: ToolActivity }): JSX.Element {
  const icon = ICON[tool.name] ?? <Wrench size={14} />
  const running = tool.phase === 'running'
  const error = tool.phase === 'error'
  return (
    <div className={`toolcard ${running ? 'toolcard--running' : ''} ${error ? 'toolcard--error' : ''}`}>
      <span className="toolcard__icon">{icon}</span>
      <span className="toolcard__title">{tool.title || tool.name}</span>

      {(tool.added !== undefined || tool.removed !== undefined) && (
        <span className="toolcard__diff">
          {tool.added ? <span className="diff-add">+{tool.added}</span> : null}
          {tool.removed ? <span className="diff-del">−{tool.removed}</span> : null}
        </span>
      )}

      {tool.detail && !running && <span className="toolcard__detail">{tool.detail}</span>}

      <span className="toolcard__status">
        {running ? (
          <Loader2 size={13} className="spin" />
        ) : error ? (
          <TriangleAlert size={13} style={{ color: 'var(--err)' }} />
        ) : (
          <Check size={13} style={{ color: 'var(--ok)' }} />
        )}
      </span>
    </div>
  )
}
