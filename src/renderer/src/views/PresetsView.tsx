import { useState } from 'react'
import { nanoid } from 'nanoid'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useStore } from '../state/store'
import { api } from '../lib/api'
import type { Preset } from '../../../shared/ipc'

export function PresetsView(): JSX.Element {
  const presets = useStore((s) => s.presets)
  const providers = useStore((s) => s.providers)
  const models = useStore((s) => s.models)
  const loadPresets = useStore((s) => s.loadPresets)
  const loadModels = useStore((s) => s.loadModels)
  const [editing, setEditing] = useState<Preset | null>(null)

  const startNew = (): void => {
    const p = providers[0]
    setEditing({
      id: nanoid(8),
      name: 'New preset',
      providerId: p?.id ?? '',
      model: p?.defaultModel ?? '',
      systemPrompt: '',
      params: { temperature: 0.7, maxOutputTokens: 4096 }
    })
    if (p) void loadModels(p.id)
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    await api.savePreset(editing)
    setEditing(null)
    await loadPresets()
  }

  const remove = async (id: string): Promise<void> => {
    await api.deletePreset(id)
    await loadPresets()
  }

  const providerModels = editing ? models[editing.providerId] ?? [] : []

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Presets</div>
        <div className="view__sub">
          Reusable configurations — provider, model, system prompt and sampling parameters. Apply one from the
          Parameters panel to switch your whole setup at once.
        </div>

        <button className="btn btn--primary" style={{ marginBottom: 20 }} onClick={startNew} disabled={providers.length === 0}>
          <Plus size={15} /> New preset
        </button>

        {editing && (
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 650 }}>Edit preset</span>
              <button className="iconbtn" onClick={() => setEditing(null)}><X size={16} /></button>
            </div>
            <div className="grid" style={{ gap: 14 }}>
              <label className="label">
                Name
                <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <div className="row">
                <label className="label" style={{ flex: 1 }}>
                  Provider
                  <select
                    className="select"
                    value={editing.providerId}
                    onChange={(e) => {
                      setEditing({ ...editing, providerId: e.target.value })
                      void loadModels(e.target.value)
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="label" style={{ flex: 1 }}>
                  Model
                  <select className="select" value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
                    <option value="">Select model</option>
                    {providerModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="label">
                System prompt
                <textarea
                  className="textarea"
                  rows={4}
                  value={editing.systemPrompt ?? ''}
                  placeholder="You are a precise engineering assistant…"
                  onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                />
              </label>
              <div className="row" style={{ gap: 20 }}>
                <label className="label">
                  Temperature
                  <input
                    className="numbox"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={editing.params?.temperature ?? 0.7}
                    onChange={(e) => setEditing({ ...editing, params: { ...editing.params, temperature: Number(e.target.value) } })}
                  />
                </label>
                <label className="label">
                  Max output
                  <input
                    className="numbox"
                    type="number"
                    value={editing.params?.maxOutputTokens ?? 4096}
                    onChange={(e) => setEditing({ ...editing, params: { ...editing.params, maxOutputTokens: Number(e.target.value) } })}
                  />
                </label>
              </div>
            </div>
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn btn--primary" onClick={() => void save()}>Save preset</button>
              <button className="btn btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="grid">
          {presets.map((p) => (
            <div key={p.id} className="card card--row">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="muted mono" style={{ marginTop: 4 }}>
                  {p.providerId} · {p.model} · temp {p.params?.temperature ?? '—'} · max {p.params?.maxOutputTokens ?? '—'}
                </div>
                {p.systemPrompt && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6, maxWidth: '60ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.systemPrompt}
                  </div>
                )}
              </div>
              <div className="row">
                <button className="btn" onClick={() => { setEditing(p); void loadModels(p.providerId) }}>
                  <Pencil size={14} /> Edit
                </button>
                <button className="btn btn--danger" onClick={() => void remove(p.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {presets.length === 0 && (
            <div className="empty">
              {providers.length === 0 ? 'Add a provider first, then create presets.' : 'No presets yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
