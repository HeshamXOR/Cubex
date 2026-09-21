import { useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { api, formatBytes } from '../lib/api'
import type { BenchmarkResult } from '@core/types'
import type { LocalModelEntry } from '../../../shared/ipc'

export function BenchmarksView(): JSX.Element {
  const [models, setModels] = useState<LocalModelEntry[]>([])
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [running, setRunning] = useState<{ benchId: string; progress: number } | null>(null)
  const [selected, setSelected] = useState('')
  const [runs, setRuns] = useState(3)

  const refresh = async (): Promise<void> => {
    const [m, r] = await Promise.all([api.listLocalModels(), api.listBenchmarks()])
    setModels(m)
    setResults(r)
    setSelected((cur) => cur || m[0]?.id || '')
  }

  useEffect(() => {
    void refresh()
    return api.onBenchmarkProgress((p) => {
      if (p.done) {
        setRunning(null)
        void refresh()
      } else setRunning({ benchId: p.benchId, progress: p.progress ?? 0 })
    })
  }, [])

  const start = async (): Promise<void> => {
    const model = models.find((m) => m.id === selected)
    if (!model) return
    const { benchId } = await api.runBenchmark({
      config: {
        modelId: model.id,
        runtime: model.runtime,
        prompt: 'Write a short paragraph explaining what a transformer neural network is.',
        maxOutputTokens: 200,
        runs
      }
    })
    setRunning({ benchId, progress: 0 })
  }

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Benchmarks</div>
        <div className="view__sub">
          Run a controlled generation test on an installed local model. Results are <strong>measured</strong> values,
          not estimates, and each is stored with its exact configuration so runs at different settings are never
          compared as equivalent.
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <select className="select" style={{ minWidth: 240 }} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="" disabled>Select an installed model</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.runtime})</option>
              ))}
            </select>
            <label className="row" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Runs</span>
              <input className="numbox" type="number" min={1} max={20} value={runs} onChange={(e) => setRuns(Number(e.target.value))} />
            </label>
            {running ? (
              <button className="btn btn--danger" onClick={() => void api.cancelBenchmark(running.benchId)}>
                <Square size={13} /> Stop · {Math.round(running.progress * 100)}%
              </button>
            ) : (
              <button className="btn btn--primary" onClick={() => void start()} disabled={!selected}>
                <Play size={14} /> Run benchmark
              </button>
            )}
          </div>
          {models.length === 0 && (
            <div className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
              No local models installed. Pull one in Local Models first, or set <code>CUBEX_MOCK_LOCAL=1</code> to try
              the mock runtime.
            </div>
          )}
        </div>

        <div className="grid">
          {results.map((r) => (
            <div key={r.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{r.config.modelId}</span>
                <span className="badge">measured · {r.runsData.length} runs · {new Date(r.completedAt).toLocaleString()}</span>
              </div>
              <div className="row" style={{ marginTop: 14, gap: 28, flexWrap: 'wrap' }}>
                <Stat
                  label="Generation"
                  value={`${r.tokensPerSecond.mean.toFixed(1)} tok/s`}
                  sub={`median ${r.tokensPerSecond.median.toFixed(1)} · ${r.tokensPerSecond.min.toFixed(1)}–${r.tokensPerSecond.max.toFixed(1)} · σ ${r.tokensPerSecond.stddev.toFixed(2)}`}
                />
                <Stat label="Time to first token" value={`${(r.ttftMs.mean / 1000).toFixed(2)}s`} sub={`median ${(r.ttftMs.median / 1000).toFixed(2)}s`} />
                {r.peakVramBytes ? <Stat label="Peak VRAM" value={formatBytes(r.peakVramBytes)} /> : null}
              </div>
              <div className="muted mono" style={{ fontSize: 11, marginTop: 12 }}>
                config: {r.config.runtime} · maxTokens {r.config.maxOutputTokens}
                {r.config.contextTokens ? ` · ctx ${r.config.contextTokens}` : ''}
                {r.config.temperature !== undefined ? ` · temp ${r.config.temperature}` : ''}
              </div>
            </div>
          ))}
          {results.length === 0 && <div className="empty">No benchmark results yet.</div>}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 17, marginTop: 3 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
