import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import type { PermissionMode, WorktreePlan } from '../../../shared/ipc'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { MAX_RACE_MODELS, startRace, startWorktreeTask, useWorktreeUi, type RaceModel } from '../lib/worktreeTasks'
import { selectableProvider, useStore } from '../state/store'
import './worktrees.css'

const MODES: Array<[PermissionMode, string, string]> = [
  ['acceptEdits', 'Approve edits', 'Each model edits freely in its own worktree. Commands still ask you.'],
  ['default', 'Ask for everything', 'Every edit and command asks you, for every model.'],
  ['bypass', 'Approve everything', 'Nothing asks. Commands run on your computer without any check, so use this only for a project you trust.']
]

/** Choosing the models of a race. They are looked up from every provider the person has turned on. */
function ModelPicker({ chosen, onChange }: { chosen: RaceModel[]; onChange: (next: RaceModel[]) => void }): JSX.Element {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const loadModels = useStore((s) => s.loadModels)
  const [filter, setFilter] = useState('')
  const usable = useMemo(() => providers.filter((provider) => selectableProvider(provider, settings)), [providers, settings])
  useEffect(() => {
    for (const provider of usable) if (!models[provider.id]) void loadModels(provider.id).catch(() => undefined)
    // Each provider's list only needs asking for once.
  }, [usable])
  const needle = filter.trim().toLowerCase()
  const isChosen = (providerId: string, model: string): boolean => chosen.some((entry) => entry.providerId === providerId && entry.model === model)
  const toggle = (entry: RaceModel): void => {
    if (isChosen(entry.providerId, entry.model)) onChange(chosen.filter((other) => !(other.providerId === entry.providerId && other.model === entry.model)))
    else if (chosen.length < MAX_RACE_MODELS) onChange([...chosen, entry])
  }
  return (
    <div className="wt-models">
      <input className="input" aria-label="Filter models" placeholder="Filter models" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="wt-models__list">
        {usable.map((provider) => {
          const listed = (models[provider.id] ?? []).filter((model) => !needle || model.id.toLowerCase().includes(needle) || (model.displayName ?? '').toLowerCase().includes(needle))
          if (listed.length === 0) return null
          return (
            <fieldset key={provider.id} className="wt-models__group">
              <legend>{provider.name}</legend>
              {listed.map((model) => {
                const on = isChosen(provider.id, model.id)
                const label = model.displayName || model.id
                return (
                  <label key={model.id} className="wt-models__row">
                    <input type="checkbox" checked={on} disabled={!on && chosen.length >= MAX_RACE_MODELS} onChange={() => toggle({ providerId: provider.id, model: model.id, label })} />
                    <span>{label}</span>
                  </label>
                )
              })}
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}

/** Read before anything is created: where the work will happen, and exactly which commands will run. */
export function WorktreeDialog(): JSX.Element | null {
  const dialog = useWorktreeUi((s) => s.dialog)
  const close = useWorktreeUi((s) => s.closeDialog)
  const workspace = useStore((s) => (s.activeConversation ? s.activeConversation.worktree?.repoRoot ?? s.activeConversation.workspacePath : s.settings?.general.workspacePath))
  const draft = useStore((s) => s.composerText)
  const [plan, setPlan] = useState<WorktreePlan>()
  const [setup, setSetup] = useState('')
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<RaceModel[]>([])
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const panel = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!dialog) return
    setPlan(undefined)
    setError(undefined)
    setBusy(false)
    setText(draft)
    setChosen([])
    setMode('acceptEdits')
    if (!workspace) { setPlan({ ok: false, reason: 'Choose a project folder first.' }); return }
    let current = true
    void api.worktreePlan(workspace).then((next) => {
      if (!current) return
      setPlan(next)
      if (next.ok) setSetup(next.setup.join('\n'))
    }).catch((failure: unknown) => { if (current) setPlan({ ok: false, reason: failure instanceof Error ? failure.message : String(failure) }) })
    panel.current?.focus()
    return () => { current = false }
    // The draft is only read as the dialog opens.
  }, [dialog, workspace])

  useEffect(() => {
    if (!dialog) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); close() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog, busy, close])

  if (!dialog) return null
  const race = dialog === 'race'
  const ready = plan?.ok ? plan : undefined
  const commands = setup.split('\n').map((line) => line.trim()).filter(Boolean)
  const canStart = !!ready && !!workspace && !busy && (!race || (chosen.length >= 2 && !!text.trim()))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canStart || !ready || !workspace) return
    setBusy(true)
    setError(undefined)
    if (race) {
      // The race has its own page from here on, which reports what happens.
      useStore.getState().setComposerText('')
      void startRace({ plan: ready, workspace, text: text.trim(), models: chosen, setup: commands, mode }).catch((failure: unknown) => {
        useWorktreeUi.setState({ raceStage: undefined, raceProblems: [failure instanceof Error ? failure.message : String(failure)] })
      })
      return
    }
    void startWorktreeTask(ready, workspace, commands).then((problem) => {
      if (problem) useStore.setState({ status: 'error', statusDetail: `The worktree is ready, but its setup did not finish: ${problem}` })
      close()
    }).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    })
  }

  return (
    <div className="sheet" onClick={() => { if (!busy) close() }}>
      <form className="sheet__panel wt-dialog" role="dialog" aria-modal="true" aria-labelledby="wt-title" tabIndex={-1} ref={panel} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="sheet__head">
          <h2 id="wt-title">{race ? 'Try on several models' : 'New task in a worktree'}</h2>
          <button type="button" className="ib" onClick={close} disabled={busy} aria-label="Close" title="Close"><X size={15} /></button>
        </div>
        <div className="wt-dialog__body">
          {!plan && <p className="wt-note">Reading the project.</p>}
          {plan && !plan.ok && <p className="wt-note" role="alert">{plan.reason}</p>}
          {ready && (
            <>
              <p className="wt-note">
                {race
                  ? `Each model works on its own copy of ${ready.branch}, on a branch of its own. You compare the results, then bring one back. Your project folder stays as it is until you do.`
                  : `The task works on its own copy of ${ready.branch}, on a branch of its own. Your project folder stays as it is until you bring the result back.`}
              </p>
              {ready.uncommitted > 0 && <p className="wt-note wt-note--warn">{plural(ready.uncommitted, 'uncommitted change')} in your project folder will not be in the copy. Only what is committed comes along.</p>}
              {race && (
                <>
                  <label className="wt-field">
                    <span>What should they do?</span>
                    <textarea className="input" rows={4} value={text} onChange={(event) => setText(event.target.value)} />
                  </label>
                  <div className="wt-field">
                    <span>Models, {chosen.length} of up to {MAX_RACE_MODELS} chosen</span>
                    <ModelPicker chosen={chosen} onChange={setChosen} />
                    {chosen.length >= 2 && <p className="wt-hint">This costs about {chosen.length} times as much as asking one model.</p>}
                  </div>
                  <label className="wt-field">
                    <span>Permissions</span>
                    <select className="select" value={mode} onChange={(event) => setMode(event.target.value as PermissionMode)}>
                      {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <span className="wt-hint">{MODES.find(([value]) => value === mode)?.[2]}</span>
                  </label>
                </>
              )}
              <label className="wt-field">
                <span>Setup commands, one per line</span>
                <textarea className="input mono" rows={Math.max(2, commands.length)} value={setup} spellCheck={false} placeholder="None" onChange={(event) => setSetup(event.target.value)} />
                <span className="wt-hint">
                  {ready.setupFromProject
                    ? 'From this project\'s .cubex/worktrees.json. Read them first: they run on your computer in each new copy.'
                    : 'Guessed from the project. They run on your computer in each new copy. Add a .cubex/worktrees.json to set your own.'}
                </span>
              </label>
              {ready.copy.length > 0 && <p className="wt-hint">Also copied from your project folder: {ready.copy.join(', ')}</p>}
            </>
          )}
          {error && <p className="wt-note wt-note--warn" role="alert">{error}</p>}
        </div>
        <div className="wt-dialog__foot">
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!canStart}>{busy ? 'Working' : race ? `Start ${chosen.length >= 2 ? chosen.length : ''} runs`.replace('  ', ' ') : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
