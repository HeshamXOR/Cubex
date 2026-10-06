import { useEffect, useState } from 'react'
import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { DiagnosticItem, DiagnosticsStatus } from '../../../shared/ipc'
import { api } from '../lib/api'
import { splitPath } from '../lib/format'
import { countProblems, describeProblems } from '../lib/problemCounts'
import { loadProblems } from '../lib/problems'
import { useStore } from '../state/store'
import { ActivityGlyph } from '../theme/StateIcons'
import { ProblemsChip } from './ProblemsChip'
import './problems.css'

export interface ProblemRowsProps {
  items: readonly DiagnosticItem[]
  /** How many problems exist beyond the ones listed, when the list is only the first of them. */
  hidden?: number
  /** Mark each problem as an error or a warning. By default that happens only when the list mixes both. */
  severity?: boolean
  /** The person picked a problem. */
  onOpen: (item: DiagnosticItem) => void
}

/** Problems as `line:col message`, each one a button that opens its file. */
export function ProblemRows({ items, hidden = 0, severity, onOpen }: ProblemRowsProps): JSX.Element {
  const marked = severity ?? items.some((item) => item.severity === 'warning')
  return (
    <>
      <ul className="problems">
        {items.map((item) => {
          const warning = item.severity === 'warning'
          return (
            <li key={`${item.path}:${item.line}:${item.col}:${item.code ?? ''}`}>
              <button className="problem" onClick={() => onOpen(item)} title={`Open ${item.path} in the review panel`}>
                {marked && (warning
                  ? <TriangleAlert size={12} aria-label="Warning" className="problem__sev problem__sev--warn" />
                  : <CircleAlert size={12} aria-label="Error" className="problem__sev problem__sev--error" />)}
                <span className="problem__at">{item.line}:{item.col}</span>
                <span className="problem__msg">
                  {item.message}
                  {item.code && <span className="problem__code">{item.code}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {hidden > 0 && <p className="problems__more">{hidden === 1 ? '1 more problem is not shown' : `${hidden} more problems are not shown`}</p>}
    </>
  )
}

export interface ProblemsListProps {
  /** The task whose workspace is checked. Nothing loads without one. */
  conversationId: string | undefined
  /** One workspace-relative file. Omit it to list the problems of every file the task changed. */
  path?: string
  /** Changes whenever the file or the task's edits do, so the list asks again. */
  version?: string | number
  /** What choosing a problem does. By default its file opens in the review panel. */
  onOpen?: (item: DiagnosticItem) => void
}

type Loaded =
  | { phase: 'ready'; items: DiagnosticItem[]; unavailable?: string }
  | { phase: 'failed'; message: string }

/**
 * The compiler problems a file, or every file a task changed, has right now: loading, a list, "No problems found",
 * or the reason checks cannot run together with how to fix it. It asks the checker itself and keeps the previous
 * list on screen while a newer one loads.
 */
export function ProblemsList({ conversationId, path, version, onOpen }: ProblemsListProps): JSX.Element {
  const openReview = useStore((state) => state.openReview)
  const [loaded, setLoaded] = useState<{ key: string; result: Loaded }>()
  const key = `${conversationId ?? ''}\0${path ?? ''}`

  useEffect(() => {
    if (!conversationId) return
    let alive = true
    const done = (result: Loaded): void => { if (alive) setLoaded({ key, result }) }
    loadProblems(conversationId, path).then(
      async (items) => {
        if (items.length > 0) return done({ phase: 'ready', items })
        // Empty means clean, or not checked at all. The status tells which, and what to do about it.
        const status: DiagnosticsStatus | undefined = await api.getDiagnosticsStatus(conversationId).catch(() => undefined)
        done({ phase: 'ready', items, ...(status && !status.available ? { unavailable: status.reason ?? 'Problems are not checked for this folder.' } : {}) })
      },
      (cause: unknown) => done({ phase: 'failed', message: cause instanceof Error ? cause.message : 'The checker did not answer.' })
    )
    return () => { alive = false }
  }, [conversationId, path, version, key])

  if (!conversationId) {
    return <div className="problems-list"><p className="problems-state" role="status"><Info size={14} aria-hidden="true" />Problems appear here once a task has changed files.</p></div>
  }
  // A list for another file or task is not an answer for this one.
  const result = loaded?.key === key ? loaded.result : undefined
  if (!result) {
    return <div className="problems-list" aria-busy="true"><p className="problems-state" role="status"><ActivityGlyph kind="thinking" size={14} active />Checking for problems</p></div>
  }
  if (result.phase === 'failed') {
    return (
      <div className="problems-list">
        <div className="callout callout--error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <div className="callout__body"><strong>Problems could not be loaded</strong>{result.message}</div>
        </div>
      </div>
    )
  }
  if (result.items.length === 0) {
    return result.unavailable
      ? <div className="problems-list"><p className="problems-state problems-state--attention" role="status"><CircleAlert size={14} aria-hidden="true" />{result.unavailable}</p></div>
      : <div className="problems-list"><p className="problems-state problems-state--ok" role="status"><Check size={14} aria-hidden="true" />No problems found</p></div>
  }

  const open = onOpen ?? ((item: DiagnosticItem): void => openReview(item.path))
  const files = path ? undefined : groupByFile(result.items)
  // One decision for the whole list, so the columns line up from one file to the next.
  const severity = result.items.some((item) => item.severity === 'warning')
  return (
    <div className="problems-list">
      {files
        ? files.map(({ file, items }) => {
          const { dir, name } = splitPath(file)
          return (
            <section key={file}>
              <h3 className="problems-file">
                <span className="problems-file__name" title={file}>{dir}<b>{name}</b></span>
                <ProblemsChip {...countProblems(items)} />
              </h3>
              <ProblemRows items={items} severity={severity} onOpen={open} />
            </section>
          )
        })
        : <ProblemRows items={result.items} severity={severity} onOpen={open} />}
      <p className="sr-only" role="status">{describeProblems(countProblems(result.items))}</p>
    </div>
  )
}

function groupByFile(items: readonly DiagnosticItem[]): Array<{ file: string; items: DiagnosticItem[] }> {
  const groups = new Map<string, DiagnosticItem[]>()
  for (const item of items) {
    const list = groups.get(item.path)
    if (list) list.push(item)
    else groups.set(item.path, [item])
  }
  return [...groups].map(([file, list]) => ({ file, items: list }))
}
