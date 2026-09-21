import { useEffect, useState } from 'react'
import { Download, Eye, Scale, Search, Wrench } from 'lucide-react'
import { api, formatBytes } from '../lib/api'
import type { ModelInfo } from '@core/types'

const TASKS = [
  { id: 'all', label: 'All tasks' },
  { id: 'coding', label: 'Coding' },
  { id: 'vision', label: 'Vision' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'embeddings', label: 'Embeddings' }
]

export function ModelBrowserView(): JSX.Element {
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [task, setTask] = useState('all')

  const search = async (q = query): Promise<void> => setModels(await api.browseModels(q || undefined))

  useEffect(() => {
    void search('')
  }, [])

  const filtered = models.filter((m) => {
    if (task === 'all') return true
    if (task === 'vision') return m.capabilities.includes('vision')
    if (task === 'coding') return `${m.displayName} ${m.family ?? ''}`.toLowerCase().includes('cod')
    if (task === 'embeddings') return m.modalities.output.includes('embedding')
    if (task === 'reasoning') return m.supportsReasoning
    return true
  })

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Model Browser</div>
        <div className="view__sub">
          Open-source models with factual metadata. Licenses are shown as declared by their authors — always read the
          model card before commercial use. Cubex never claims a model is free for commercial use.
        </div>

        <div className="row" style={{ marginBottom: 20 }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-3)' }} />
            <input
              className="input"
              style={{ width: '100%', paddingLeft: 34 }}
              value={query}
              placeholder="Search models…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
            />
          </div>
          <select className="select" value={task} onChange={(e) => setTask(e.target.value)}>
            {TASKS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <button className="btn" onClick={() => void search()}>Search</button>
        </div>

        <div className="grid">
          {filtered.map((m) => (
            <div key={m.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{m.displayName}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                    {[m.organization, m.family, m.architecture].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {m.parameterCount ? <span className="badge">{m.parameterCount}B</span> : null}
                  {m.quantization ? <span className="badge">{m.quantization}</span> : null}
                  {m.capabilities.includes('vision') && <span className="badge"><Eye size={11} /> vision</span>}
                  {m.supportsTools && <span className="badge"><Wrench size={11} /> tools</span>}
                </div>
              </div>

              <div className="row" style={{ marginTop: 14, gap: 22, flexWrap: 'wrap', fontSize: 12.5 }}>
                <Meta icon={<Download size={12} />} label="Size" value={formatBytes(m.downloadSizeBytes)} />
                <Meta label="Context" value={m.contextWindow?.toLocaleString() ?? '—'} />
                <Meta icon={<Scale size={12} />} label="License" value={m.license ?? '—'} />
                <Meta label="Runtimes" value={m.supportedRuntimes?.join(', ') ?? '—'} />
                {m.downloads ? <Meta label="Downloads" value={m.downloads.toLocaleString()} /> : null}
              </div>
              {m.notes && <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>{m.notes}</div>}
            </div>
          ))}
          {filtered.length === 0 && <div className="empty">No models match that filter.</div>}
        </div>
      </div>
    </div>
  )
}

function Meta({ icon, label, value }: { icon?: JSX.Element; label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="muted row" style={{ fontSize: 11, gap: 4 }}>
        {icon}
        {label}
      </div>
      <div style={{ fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  )
}
