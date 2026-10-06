import { useEffect, useRef, useState } from 'react'
import { CircleCheck, CircleDashed, Clock, Download, HardDrive, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react'
import { api, formatBytes } from '../lib/api'
import { formatEta, plainError, pullFileLine, pullStage, pullWaitingText, runtimeName, stalledText } from '../lib/localModels'
import { StateIcon } from '../status/StatusIndicator'
import { DEFAULT_RUNTIME, sortPulls, type Pull } from '../state/pullModel'
import { usePulls } from '../state/pulls'
import { isModelName, MODEL_NAME_HINT } from '../../../shared/modelName'
import type { LocalModelEntry, RuntimeStatus } from '../../../shared/ipc'
import './localModels.css'

export function LocalModelsView(): JSX.Element {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [models, setModels] = useState<LocalModelEntry[]>([])
  const [pullName, setPullName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const mounted = useRef(true)
  const pulls = usePulls((s) => s.pulls)
  const finished = usePulls((s) => s.finished)
  const startPull = usePulls((s) => s.start)
  const cancelPull = usePulls((s) => s.cancel)
  const dismissPull = usePulls((s) => s.dismiss)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const [rt, m] = await Promise.all([api.listRuntimes(), api.listLocalModels()])
      if (!mounted.current) return
      setRuntimes(rt)
      setModels(m)
      setError(null)
    } catch (err) {
      if (mounted.current) setError(`Could not check the local runtimes. ${plainError(err)}`)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  // Once on arrival, and again whenever a download finishes so the new model shows up under Installed.
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [finished])

  const submit = (): void => {
    const name = pullName.trim()
    if (!isModelName(name)) return
    setPullName('')
    void startPull(DEFAULT_RUNTIME, name)
  }

  const remove = async (model: LocalModelEntry): Promise<void> => {
    const key = `${model.runtime}:${model.id}`
    setDeleting(key)
    setError(null)
    try {
      await api.deleteLocalModel(model.runtime, model.id)
      setConfirming(null)
      await refresh()
    } catch (err) {
      setError(`Could not delete ${model.name}. ${plainError(err)}`)
    } finally {
      setDeleting(null)
    }
  }

  const all = sortPulls(pulls)
  const failed = all.filter((p) => p.error)
  const active = all.filter((p) => !p.error)
  const waiting = active.filter((p) => p.phase === 'queued').length
  const anyRunning = runtimes.some((runtime) => runtime.running)
  const typed = pullName.trim()
  const nameProblem = typed.length > 0 && !isModelName(typed)

  return (
    <div className="view">
      <div className="view__inner">
        <h1 className="view__title">Local models</h1>
        <p className="view__sub">
          The runtimes on this PC and the models they have installed. A download that stops picks up where it left off.
        </p>

        {error && (
          <div className="callout callout--error" role="alert">
            <div className="callout__body">{error}</div>
            <button className="callout__action" onClick={() => void refresh()}>Try again</button>
          </div>
        )}

        <div className="view__bar">
          <h2 className="h2">Runtimes</h2>
          <button className="btn btn--ghost" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        <div className="grid grid--auto specs">
          {runtimes.map((r) => (
            <div key={r.id} className="card spec">
              <div className="spec__head">
                <span className="spec__main">{r.name}</span>
                <span className={`badge ${r.running ? 'badge--local' : ''}`}>
                  {r.running ? <CircleCheck size={11} aria-hidden="true" /> : <CircleDashed size={11} aria-hidden="true" />}
                  {r.running ? 'Running' : 'Not running'}
                </span>
              </div>
              {r.running ? (
                <div className="spec__line mono">
                  {r.endpoint ?? 'No endpoint'}
                  {r.version ? <>{' '}<span className="spec__version">v{r.version}</span></> : null}
                </div>
              ) : (
                <div className="spec__line">{r.error ? `${r.error}.` : 'Not reachable.'} Start {r.name}, then choose Refresh.</div>
              )}
            </div>
          ))}
        </div>
        {runtimes.length === 0 && !loading && (
          <p className="view__empty">Cubex did not find a local runtime. Install Ollama, start it, then choose Refresh.</p>
        )}

        <h2 className="h2">Download a model</h2>
        <form className="row view__controls lm-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <input
            className="input view__field"
            value={pullName}
            placeholder="Ollama model tag, for example llama3.1:8b"
            aria-label="Ollama model tag"
            aria-invalid={nameProblem}
            aria-describedby={nameProblem ? 'lm-name-hint' : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPullName(e.target.value)}
          />
          <button className="btn btn--primary" type="submit" disabled={!typed || nameProblem}>
            <Download size={15} aria-hidden="true" /> Download
          </button>
        </form>
        {nameProblem && <p className="lm-hint" id="lm-name-hint">{MODEL_NAME_HINT}</p>}

        {failed.map((p) => (
          <div key={p.modelId} className="callout callout--error" role="alert">
            <TriangleAlert size={15} aria-hidden="true" />
            <div className="callout__body">
              <strong>Could not download {p.modelId}</strong>
              {p.error}
            </div>
            <div className="callout__actions">
              <button className="callout__action" onClick={() => void startPull(p.runtime ?? DEFAULT_RUNTIME, p.modelId)}>Try again</button>
              <button className="callout__icon" onClick={() => dismissPull(p)} aria-label={`Dismiss the ${p.modelId} error`}><X size={14} aria-hidden="true" /></button>
            </div>
          </div>
        ))}

        {active.length > 0 && (
          <>
            <div className="view__bar lm-bar">
              <h2 className="h2">Downloads</h2>
              <span className="lm-count">{active.length - waiting} running{waiting > 0 ? `, ${waiting} waiting` : ''}</span>
            </div>
            <div className="lm-group" role="list" aria-label="Downloads">
              {active.map((p, i) => (
                <DownloadRow key={`${p.runtime ?? DEFAULT_RUNTIME}:${p.modelId}`} pull={p} after={active[i - 1]?.modelId} onCancel={() => cancelPull(p)} />
              ))}
            </div>
          </>
        )}

        <h2 className="h2">Installed</h2>
        {models.length > 0 && (
          <div className="lm-group" role="list" aria-label="Installed models">
            {models.map((m) => {
              const key = `${m.runtime}:${m.id}`
              const asking = confirming === key
              const meta = [runtimeName(m.runtime), formatBytes(m.sizeBytes), m.quantization, m.parameterCount ? `${m.parameterCount}B` : '']
                .filter((part) => part && part !== '—')
                .join(', ')
              return (
                <div key={key} className="lm-installed" role="listitem">
                  <div className="lm-installed__row">
                    <HardDrive size={16} className="lm-installed__icon" aria-hidden="true" />
                    <div className="lm-installed__body">
                      <div className="lm-installed__name">{m.name}</div>
                      <div className="lm-installed__meta">{meta}</div>
                    </div>
                    {!asking && (
                      <button className="btn btn--ghost btn--sm lm-delete" onClick={() => setConfirming(key)} aria-label={`Delete ${m.name}`}>
                        <Trash2 size={14} aria-hidden="true" /> Delete
                      </button>
                    )}
                  </div>
                  {asking && (
                    <div className="confirm" role="group" aria-label={`Confirm deleting ${m.name}`}>
                      <p>
                        Delete {m.name}?{m.sizeBytes ? ` This frees ${formatBytes(m.sizeBytes)}.` : ''} You would have to download it again to use it.
                      </p>
                      <div className="confirm__actions">
                        <button className="btn btn--danger" onClick={() => void remove(m)} disabled={deleting === key}>{deleting === key ? 'Deleting…' : 'Delete model'}</button>
                        <button className="btn btn--ghost" onClick={() => setConfirming(null)} disabled={deleting === key}>Keep model</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {models.length === 0 && !loading && (
          <p className="view__empty">
            {anyRunning ? 'No models are installed yet. Download one above.' : 'Start Ollama to see the models installed on this PC.'}
          </p>
        )}
      </div>
    </div>
  )
}

function DownloadRow({ pull, after, onCancel }: { pull: Pull; after: string | undefined; onCancel: () => void }): JSX.Element {
  const queued = pull.phase === 'queued'
  const stalled = pull.stalledForSeconds !== undefined
  const percent = pct(pull)
  const known = pull.completedBytes !== undefined && !!pull.totalBytes
  const file = pullFileLine(pull)
  const rate = [pull.speedBps ? `${formatBytes(pull.speedBps)}/s` : '', formatEta(pull.etaSeconds) ? `${formatEta(pull.etaSeconds)} left` : ''].filter(Boolean).join(', ')
  return (
    <div className="lm-dl" role="listitem" data-phase={pull.phase ?? 'downloading'} data-stalled={stalled || undefined}>
      <span className="lm-dl__glyph" aria-hidden="true">
        {queued ? <Clock size={15} /> : <StateIcon state={stalled ? 'awaiting_input' : 'working'} size={16} />}
      </span>
      <span className="lm-dl__name">{pull.modelId}</span>
      <span className="lm-dl__side">
        <span className="lm-dl__stage">{pullStage(pull)}</span>
        <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={!pull.pullId} aria-label={`Cancel the ${pull.modelId} download`}>Cancel</button>
      </span>
      <div className="lm-dl__body">
        {queued ? (
          <p className="lm-dl__hint">{after ? `Starts after ${after}.` : 'Starts when the runtime is free.'}</p>
        ) : (
          <>
            <div
              className="progress lm-dl__bar"
              role="progressbar"
              aria-label={`${pull.modelId} download`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
              {...(known ? { 'aria-valuetext': `${formatBytes(pull.completedBytes)} of ${formatBytes(pull.totalBytes)}` } : {})}
            >
              <div className="progress__bar" style={{ width: `${percent ?? 0}%` }} />
            </div>
            <div className="lm-dl__meta">
              <span>{known ? `${formatBytes(pull.completedBytes)} of ${formatBytes(pull.totalBytes)}` : pullWaitingText(pull.phase)}</span>
              <span>{stalled ? '' : rate}</span>
            </div>
            {file && <div className="lm-dl__file">{file}</div>}
            {stalled && (
              <div className="callout callout--warn lm-dl__note" role="status">
                <TriangleAlert size={14} aria-hidden="true" />
                <div className="callout__body">{stalledText(pull.stalledForSeconds ?? 0)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Download progress as a whole percentage, or undefined while the size is not known yet. */
function pct(p: Pull): number | undefined {
  // The bytes are all in once a download is being checked or saved, whether or not the runtime repeats the count.
  if (p.phase === 'verifying' || p.phase === 'finalizing') return 100
  if (!p.completedBytes || !p.totalBytes) return undefined
  return Math.min(100, Math.round((p.completedBytes / p.totalBytes) * 100))
}
