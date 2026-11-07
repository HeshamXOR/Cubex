import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, FileDiff, Play, Trash2, Undo2, X } from 'lucide-react'
import type { RaceRun, WorktreeCommandResult } from '../../../shared/ipc'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useWorktreeUi } from '../lib/worktreeTasks'
import { useStore } from '../state/store'
import './worktrees.css'

const REFRESH_MS = 4_000

type RunStatus = 'running' | 'waiting' | 'error' | 'done'
const STATUS_WORD: Record<RunStatus, string> = { running: 'Working', waiting: 'Waiting for you', error: 'Failed', done: 'Finished' }

/** Where one task stands, whether or not it is the one open in the chat. */
function useStatuses(ids: readonly string[]): Record<string, RunStatus> {
  // A string, so the page redraws when a status changes and not on every word of every reply.
  const raw = useStore((state) => {
    const out: Record<string, RunStatus> = {}
    for (const id of ids) {
      const run = state.activeConversation?.id === id ? state : state.conversationRuns[id]
      if (!run) { out[id] = 'done'; continue }
      if (run.pendingPermission || run.pendingQuestion || run.pendingPlan) out[id] = 'waiting'
      else if (run.liveMessages.some((message) => message.streaming) || run.startingRequest) out[id] = 'running'
      else out[id] = run.status === 'error' ? 'error' : 'done'
    }
    return JSON.stringify(out)
  })
  return useMemo(() => JSON.parse(raw) as Record<string, RunStatus>, [raw])
}

/** Lines of a patch, with colour only for what was added and removed. */
function PatchText({ text }: { text: string }): JSX.Element {
  const lines = useMemo(() => text.split('\n').slice(0, 4_000), [text])
  return (
    <pre className="race-diff">
      {lines.map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'head'
          : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
        return <div key={index} className={kind ? `race-diff__${kind}` : undefined}>{line || ' '}</div>
      })}
    </pre>
  )
}

/** The same work done by several models, side by side. The person decides, on the evidence of the diffs and their own check. */
export function RaceView(): JSX.Element {
  const raceId = useWorktreeUi((s) => s.raceId)
  const stage = useWorktreeUi((s) => s.raceStage)
  const problems = useWorktreeUi((s) => s.raceProblems)
  const openConversation = useStore((s) => s.openConversation)
  const loadConversations = useStore((s) => s.loadConversations)
  const [runs, setRuns] = useState<RaceRun[]>([])
  const [diff, setDiff] = useState<{ id: string; text: string }>()
  const [check, setCheck] = useState('')
  const [checks, setChecks] = useState<Record<string, WorktreeCommandResult | 'running'>>({})
  const [notice, setNotice] = useState<string>()
  const [applied, setApplied] = useState<string>()
  const [confirming, setConfirming] = useState<string>()
  const ids = useMemo(() => runs.map((run) => run.conversationId), [runs])
  const statuses = useStatuses(ids)
  const anyRunning = Object.values(statuses).some((status) => status === 'running' || status === 'waiting')

  const refresh = useCallback(async () => {
    if (raceId) setRuns(await api.raceRuns(raceId).catch(() => []))
  }, [raceId])

  useEffect(() => { void refresh() }, [refresh, stage])
  useEffect(() => {
    if (!anyRunning) { void refresh(); return }
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [anyRunning, refresh])

  useEffect(() => {
    const first = ids[0]
    if (!first || check) return
    void api.worktreeChecks(first).then((found) => { if (found[0]) setCheck(found[0]) }).catch(() => undefined)
  }, [ids.join('|')])

  const showDiff = async (id: string): Promise<void> => {
    if (diff?.id === id) { setDiff(undefined); return }
    setDiff({ id, text: await api.worktreeDiff(id).catch(() => '') })
  }

  const runCheck = async (): Promise<void> => {
    const command = check.trim()
    if (!command) return
    setChecks(Object.fromEntries(ids.map((id) => [id, 'running' as const])))
    await Promise.all(ids.map(async (id) => {
      const result = await api.worktreeRun(id, [command]).catch((failure: unknown) => [{
        command, ok: false, exitCode: null, output: failure instanceof Error ? failure.message : String(failure)
      }] as WorktreeCommandResult[])
      setChecks((current) => ({ ...current, [id]: result[0] ?? { command, ok: false, exitCode: null, output: '' } }))
    }))
  }

  const apply = async (run: RaceRun): Promise<void> => {
    setNotice(undefined)
    const result = await api.worktreeApply(run.conversationId)
    if (result.ok) {
      setApplied(run.conversationId)
      setNotice(`${plural(result.files, 'file')} from ${run.model ?? run.title} ${result.files === 1 ? 'is now an uncommitted change' : 'are now uncommitted changes'} in your project folder.`)
    } else setNotice(result.reason)
  }

  const discard = async (id: string): Promise<void> => {
    setConfirming(undefined)
    const result = await api.worktreeDiscard(id).catch((failure: unknown) => ({ ok: false as const, reason: failure instanceof Error ? failure.message : String(failure) }))
    if (!result.ok) setNotice(result.reason)
    if (diff?.id === id) setDiff(undefined)
    await Promise.all([refresh(), loadConversations()])
  }

  const discardOthers = async (): Promise<void> => {
    for (const id of ids) if (id !== applied && statuses[id] !== 'running' && statuses[id] !== 'waiting') await discard(id)
  }

  return (
    <div className="race">
      <div className="race__head">
        <h1>Compare runs</h1>
        {anyRunning && !stage && <span className="race__state">Still working</span>}
        {stage && <span className="race__state" role="status">{stage}</span>}
      </div>
      {problems.map((problem) => <p key={problem} className="wt-note wt-note--warn" role="alert">{problem}</p>)}
      {notice && <p className="wt-note" role="status">{notice}</p>}
      {!raceId && <p className="wt-note">No race is open. Start one from the project menu in a chat.</p>}
      {raceId && !stage && runs.length === 0 && <p className="wt-note">Every run of this race has been discarded.</p>}

      {runs.length > 0 && (
        <>
          <form className="race__check" onSubmit={(event) => { event.preventDefault(); void runCheck() }}>
            <label>
              <span>Check every run with</span>
              <input className="input mono" value={check} placeholder="npm test" spellCheck={false} onChange={(event) => setCheck(event.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={!check.trim() || anyRunning || Object.values(checks).includes('running')}><Play size={13} /> Run</button>
          </form>
          <p className="wt-hint">This runs the command on your computer in each copy, including anything the models changed.</p>

          <div className="race__table" role="table" aria-label="Runs">
            <div className="race__row race__row--head" role="row">
              <span role="columnheader">Model</span><span role="columnheader">State</span><span role="columnheader">Changes</span><span role="columnheader">Check</span><span role="columnheader">Cost</span><span role="columnheader" className="sr-only">Actions</span>
            </div>
            {runs.map((run) => {
              const status = statuses[run.conversationId] ?? 'done'
              const result = checks[run.conversationId]
              const busy = status === 'running' || status === 'waiting'
              return (
                <div key={run.conversationId} className={`race__row ${applied === run.conversationId ? 'is-chosen' : ''}`} role="row">
                  <span role="cell" className="race__model" title={run.worktree.branch}>{run.model ?? run.title}</span>
                  <span role="cell">{STATUS_WORD[status]}</span>
                  <span role="cell" className="race__stat">
                    {run.summary.files === 0 ? 'None' : <>{plural(run.summary.files, 'file')} <b className="race__add">+{run.summary.additions}</b> <b className="race__del">-{run.summary.deletions}</b></>}
                  </span>
                  <span role="cell" title={typeof result === 'object' ? result.output : undefined}>
                    {!result ? 'Not run' : result === 'running' ? 'Running' : result.ok ? <span className="race__pass"><Check size={13} /> Passed</span> : <span className="race__fail"><X size={13} /> Failed</span>}
                  </span>
                  <span role="cell" className="race__stat">{run.costUsd === undefined ? 'Unknown' : `$${run.costUsd.toFixed(run.costUsd < 1 ? 3 : 2)}`}</span>
                  <span role="cell" className="race__actions">
                    <button className="ib" onClick={() => void showDiff(run.conversationId)} aria-pressed={diff?.id === run.conversationId} aria-label={`Show the changes from ${run.model ?? run.title}`} title="Show the changes" disabled={run.summary.files === 0}><FileDiff size={15} /></button>
                    <button className="ib" onClick={() => void openConversation(run.conversationId)} aria-label={`Open the conversation with ${run.model ?? run.title}`} title="Open the conversation"><ExternalLink size={15} /></button>
                    <button className="btn btn--small" onClick={() => void apply(run)} disabled={busy || run.summary.files === 0 || !!applied}><Undo2 size={13} /> Use this one</button>
                    {confirming === run.conversationId
                      ? <button className="btn btn--small" onClick={() => void discard(run.conversationId)}>Delete it</button>
                      : <button className="ib" onClick={() => setConfirming(run.conversationId)} disabled={busy} aria-label={`Discard the run from ${run.model ?? run.title}`} title="Discard this run"><Trash2 size={15} /></button>}
                  </span>
                </div>
              )
            })}
          </div>
          {applied && ids.length > 1 && <button className="btn race__others" onClick={() => void discardOthers()}>Discard the other {plural(ids.length - 1, 'run')}</button>}
          {diff && <PatchText text={diff.text || 'No changes.'} />}
        </>
      )}
    </div>
  )
}
