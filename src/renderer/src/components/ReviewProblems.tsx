import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { SessionFileChange } from '../../../shared/ipc'
import { useFileProblems } from '../lib/problems'
import { useStore } from '../state/store'
import { ProblemsChip } from './ProblemsChip'
import { ProblemsList } from './ProblemsList'
import './hunks.css'

/**
 * What the compiler says about the file under review, between its header and its diff: the count, and the list one
 * click away. A clean file shows nothing, and neither does a file while checks are off, like the chip on its row.
 */
export function ReviewProblems({ conversationId, file }: { conversationId: string; file: SessionFileChange }): JSX.Element | null {
  const checking = useStore((state) => state.settings?.diagnostics?.afterEdit === 'errors')
  const counts = useFileProblems(conversationId, file.path, file.updatedAt, checking && file.status !== 'deleted')
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!counts || counts.errors + counts.warnings === 0) return null

  return (
    <div className="rv-problems">
      <button type="button" className="rv-problems__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((shown) => !shown)}>
        <ChevronRight size={13} aria-hidden="true" />
        <span>Problems in this file</span>
        <ProblemsChip {...counts} />
      </button>
      {open && (
        <div id={id} className="rv-problems__list">
          <ProblemsList conversationId={conversationId} path={file.path} version={file.updatedAt} />
        </div>
      )}
    </div>
  )
}
