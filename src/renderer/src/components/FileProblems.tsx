import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DiagnosticsSummary } from '../../../shared/ipc'
import { describeProblems } from '../lib/problemCounts'
import { useStore } from '../state/store'
import { ProblemRows } from './ProblemsList'
import './problems.css'

/**
 * Wraps an edited file's row in the thread. When the edit introduced problems that were kept with it, a chevron at
 * the row's end opens them as `line:col message`, each one opening the file in the review panel. Rows without
 * problems, or whose problems were not kept (warnings are counted but not listed), pass through untouched.
 */
export function FileProblems({ diagnostics, children }: { diagnostics?: DiagnosticsSummary; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const openReview = useStore((state) => state.openReview)
  const id = useId()
  const items = diagnostics?.items ?? []
  if (!diagnostics || items.length === 0) return <>{children}</>

  const summary = describeProblems(diagnostics)
  return (
    <div className="fileline">
      {children}
      <button
        className={`fileline__toggle ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${open ? 'Hide' : 'Show'} ${summary}`}
        title={`${open ? 'Hide' : 'Show'} ${summary}`}
      >
        <ChevronRight size={13} aria-hidden="true" />
      </button>
      {open && (
        <div id={id}>
          <ProblemRows items={items} hidden={Math.max(0, diagnostics.errors - items.length)} onOpen={(item) => openReview(item.path)} />
        </div>
      )}
    </div>
  )
}
