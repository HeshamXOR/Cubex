import { useEffect, useState } from 'react'
import type { DirEntry } from '../../../../shared/ipc'
import { api } from '../../lib/api'
import { iconFor } from '../../lib/fileKinds'
import { splitMatch } from '../../lib/fileTree'

export interface FileSearch {
  status: 'idle' | 'loading' | 'ready' | 'error'
  results: DirEntry[]
  error?: string
}

const RESULT_LIMIT = 60
const TYPING_PAUSE_MS = 140

/** Files whose name or folders contain what was typed. Waits for a pause in typing, and ignores answers to older queries. */
export function useFileSearch(query: string, conversationId: string | undefined, showHidden: boolean): FileSearch {
  const [search, setSearch] = useState<FileSearch>({ status: 'idle', results: [] })
  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setSearch({ status: 'idle', results: [] })
      return
    }
    let live = true
    setSearch((current) => ({ ...current, status: 'loading' }))
    const timer = window.setTimeout(() => {
      api.findWorkspaceFiles(text, RESULT_LIMIT, conversationId, { showHidden }).then(
        (results) => { if (live) setSearch({ status: 'ready', results }) },
        (cause: unknown) => { if (live) setSearch({ status: 'error', results: [], error: cause instanceof Error ? cause.message : 'The search could not run.' }) }
      )
    }, TYPING_PAUSE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query, conversationId, showHidden])
  return search
}

function Marked({ text, query }: { text: string; query: string }): JSX.Element {
  const [before, match, after] = splitMatch(text, query)
  return match ? <>{before}<mark className="fx-mark">{match}</mark>{after}</> : <>{text}</>
}

interface ResultsProps {
  query: string
  search: FileSearch
  active: number
  onActive: (index: number) => void
  onPick: (entry: DirEntry) => void
}

export const resultId = (index: number): string => `fx-result-${index}`

/** Whether the result list is on screen. A failed or empty search shows a message in its place. */
export const hasResultList = (search: FileSearch): boolean => search.status !== 'error' && !(search.status === 'ready' && search.results.length === 0)

/** What the search found, as a list the search field drives with the arrow keys. */
export function SearchResults({ query, search, active, onActive, onPick }: ResultsProps): JSX.Element {
  const { results } = search
  if (search.status === 'error') {
    return <div className="callout callout--error fx-notice" role="alert"><div className="callout__body"><strong>Search could not run</strong>{search.error}</div></div>
  }
  if (!hasResultList(search)) {
    return (
      <div className="rev-empty" role="status">
        <h2>No files match</h2>
        <p>Nothing has &ldquo;{query.trim()}&rdquo; in its name or folders. Turn on Show hidden and ignored to include dot-files.</p>
      </div>
    )
  }
  return (
    <>
      {results.length > 0 && <div className="fx-summary" role="status">{results.length === RESULT_LIMIT ? `First ${RESULT_LIMIT} files` : results.length === 1 ? '1 file' : `${results.length} files`}</div>}
      <div className="fx-list fx-results" role="listbox" id="fx-results" aria-label="Search results">
        {results.map((entry, index) => {
          const Icon = iconFor(entry.name)
          const slash = entry.path.lastIndexOf('/')
          const dir = slash < 0 ? '' : entry.path.slice(0, slash + 1)
          return (
            <div
              key={entry.path}
              id={resultId(index)}
              role="option"
              aria-selected={index === active}
              className="fx-row fx-result"
              data-active={index === active || undefined}
              data-hidden={entry.hidden || undefined}
              onMouseMove={() => index !== active && onActive(index)}
              onClick={() => onPick(entry)}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="fx-name"><Marked text={entry.name} query={query} /></span>
              {dir && <span className="fx-dir"><bdi><Marked text={dir} query={query} /></bdi></span>}
            </div>
          )
        })}
      </div>
    </>
  )
}
