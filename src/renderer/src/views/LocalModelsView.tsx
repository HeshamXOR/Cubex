import { useEffect, useState } from 'react'
import { CircleCheck, CircleDashed, Download, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { api, formatBytes } from '../lib/api'
import type { LocalModelEntry, PullProgress, RuntimeStatus } from '../../../shared/ipc'

export function LocalModelsView(): JSX.Element {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [models, setModels] = useState<LocalModelEntry[]>([])
  const [pullName, setPullName] = useState('')
  const [pulls, setPulls] = useState<Record<string, PullProgress>>({})
  const [loading, setLoading] = useState(true)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    const [rt, m] = await Promise.all([api.listRuntimes(), api.listLocalModels()])
    setRuntimes(rt)
    setModels(m)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    return api.onPullProgress((p) => {
      setPulls((prev) => ({ ...prev, [p.modelId]: p }))
      if (p.done) void refresh()
    })
  }, [])

  const startPull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) return
    setPullName('')
    await api.pullModel({ runtime: 'ollama', modelId: name })
  }

  const del = async (runtime: string, id: string, size?: number): Promise<void> => {
    if (!window.confirm(`Delete "${id}"? This removes ${formatBytes(size)} of model files and cannot be undone.`)) return
    await api.deleteLocalModel(runtime, id)
    await refresh()
  }

  const active = Object.values(pulls).filter((p) => !p.done)

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Local Models</div>
        <div className="view__sub">
          Detected runtimes, installed models, and a resumable download manager. Cubex never assumes a runtime is
          installed — each is probed independently.
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="h2" style={{ margin: 0 }}>Runtimes</div>
          <button className="btn btn--ghost" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        <div className="grid grid--auto" style={{ marginTop: 12, marginBottom: 8 }}>
          {runtimes.map((r) => (
            <div key={r.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span className={`badge ${r.running ? 'badge--local' : ''}`}>
                  {r.running ? <CircleCheck size={11} /> : <CircleDashed size={11} />}
                  {r.running ? 'Running' : r.installed ? 'Stopped' : 'Not found'}
                </span>
              </div>
              <div className="muted mono" style={{ marginTop: 8 }}>
                {r.version ? `v${r.version} · ` : ''}
                {r.endpoint ?? '—'}
              </div>
              {r.error && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--warn)' }}>{r.error}</div>
              )}
            </div>
          ))}
          {runtimes.length === 0 && !loading && <div className="empty">No runtimes detected.</div>}
        </div>

        <div className="h2">Download a model</div>
        <div className="row">
          <input
            className="input"
            style={{ flex: 1, maxWidth: 360 }}
            value={pullName}
            placeholder="Ollama model tag, e.g. llama3.1:8b"
            onChange={(e) => setPullName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void startPull()}
          />
          <button className="btn btn--primary" onClick={() => void startPull()} disabled={!pullName.trim()}>
            <Download size={15} /> Pull
          </button>
        </div>

        {active.length > 0 && (
          <div className="grid" style={{ marginTop: 14 }}>
            {active.map((p) => (
              <div key={p.modelId} className="card">
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>{p.modelId}</span>
                  <span className="muted">{p.status}</span>
                </div>
                <div className="progress">
                  <div className="progress__bar" style={{ width: `${pct(p)}%` }} />
                </div>
                <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12, marginTop: 7 }}>
                  <span>
                    {p.completedBytes !== undefined && p.totalBytes
                      ? `${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)}`
                      : 'starting…'}
                  </span>
                  <span>
                    {p.speedBps ? `${formatBytes(p.speedBps)}/s` : ''}
                    {p.etaSeconds ? ` · ${Math.round(p.etaSeconds)}s left` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="h2">Installed</div>
        <div className="grid">
          {models.map((m) => (
            <div key={`${m.runtime}:${m.id}`} className="card card--row">
              <div className="row" style={{ minWidth: 0 }}>
                <HardDrive size={17} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div className="muted mono" style={{ marginTop: 4 }}>
                    {m.runtime} · {formatBytes(m.sizeBytes)}
                    {m.quantization ? ` · ${m.quantization}` : ''}
                    {m.parameterCount ? ` · ${m.parameterCount}B` : ''}
                  </div>
                </div>
              </div>
              <button className="btn btn--danger" onClick={() => void del(m.runtime, m.id, m.sizeBytes)}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          ))}
          {models.length === 0 && !loading && (
            <div className="empty">
              No local models installed. Pull one above, or install Ollama and click Refresh.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function pct(p: PullProgress): number {
  if (!p.completedBytes || !p.totalBytes) return 0
  return Math.min(100, Math.round((p.completedBytes / p.totalBytes) * 100))
}
