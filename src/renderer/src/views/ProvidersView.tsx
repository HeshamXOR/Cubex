import { useState } from 'react'
import { nanoid } from 'nanoid'
import { Check, KeyRound, Plug, Plus, TriangleAlert, X, Zap } from 'lucide-react'
import { useStore } from '../state/store'
import { api } from '../lib/api'
import type { ProviderConfig, ProviderKind, ValidationResult } from '@core/types'

interface KindPreset {
  label: string
  kind: ProviderKind
  accessType: ProviderConfig['accessType']
  baseUrl?: string
  apiMode?: string
  needsKey: boolean
  keyScheme?: 'bearer' | 'x-api-key'
  hint: string
}

const KINDS: KindPreset[] = [
  { label: 'OpenAI', kind: 'openai', accessType: 'api', baseUrl: 'https://api.openai.com/v1', apiMode: 'responses', needsKey: true, keyScheme: 'bearer', hint: 'Responses + Chat Completions' },
  { label: 'Anthropic', kind: 'anthropic', accessType: 'api', baseUrl: 'https://api.anthropic.com', needsKey: true, keyScheme: 'x-api-key', hint: 'Native Messages API' },
  { label: 'OpenAI-Compatible', kind: 'openai-compat', accessType: 'api', baseUrl: '', needsKey: true, keyScheme: 'bearer', hint: 'Any OpenAI-shaped endpoint' },
  { label: 'Ollama', kind: 'ollama', accessType: 'local', baseUrl: 'http://127.0.0.1:11434', needsKey: false, hint: 'Local runtime' },
  { label: 'LM Studio', kind: 'lmstudio', accessType: 'local', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, hint: 'Local OpenAI-compatible server' },
  { label: 'llama.cpp', kind: 'llamacpp', accessType: 'local', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, hint: 'Local server build' },
  { label: 'Custom', kind: 'custom', accessType: 'api', baseUrl: '', needsKey: true, keyScheme: 'bearer', hint: 'Map any REST/JSON API' },
  { label: 'Mock', kind: 'mock', accessType: 'api', needsKey: false, hint: 'Built-in, offline, no key' }
]

export function ProvidersView(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const loadProviders = useStore((s) => s.loadProviders)
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [secret, setSecret] = useState('')
  const [results, setResults] = useState<Record<string, ValidationResult>>({})
  const [testing, setTesting] = useState<string | null>(null)

  const startNew = (p: KindPreset): void => {
    setEditing({
      id: nanoid(8),
      kind: p.kind,
      name: p.label,
      accessType: p.accessType,
      ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiMode ? { apiMode: p.apiMode } : {}),
      auth: p.needsKey ? { type: 'api_key', scheme: p.keyScheme ?? 'bearer' } : { type: 'none' },
      enabled: true
    })
    setSecret('')
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    await api.saveProvider(editing, secret || undefined)
    setEditing(null)
    setSecret('')
    await loadProviders()
  }

  const test = async (id: string): Promise<void> => {
    setTesting(id)
    const result = await api.testProvider(id)
    setResults((p) => ({ ...p, [id]: result }))
    setTesting(null)
  }

  const remove = async (id: string): Promise<void> => {
    await api.deleteProvider(id)
    await loadProviders()
  }

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Providers</div>
        <div className="view__sub">
          Connect cloud APIs and local runtimes through one unified interface. API keys are encrypted by your OS
          keychain — configuration files only ever store a reference, never the secret.
        </div>

        <div className="grid grid--auto" style={{ marginBottom: 26 }}>
          {KINDS.map((k) => (
            <button key={k.kind + k.label} className="card card--row" onClick={() => startNew(k)} style={{ textAlign: 'left' }}>
              <div>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {k.accessType === 'local' ? <Zap size={15} style={{ color: 'var(--local)' }} /> : <Plug size={15} style={{ color: 'var(--cloud)' }} />}
                  {k.label}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{k.hint}</div>
              </div>
              <Plus size={16} style={{ color: 'var(--text-3)' }} />
            </button>
          ))}
        </div>

        {editing && (
          <div className="card" style={{ marginBottom: 26 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 650 }}>Configure {editing.name}</span>
              <button className="iconbtn" onClick={() => setEditing(null)}><X size={16} /></button>
            </div>
            <div className="grid" style={{ gap: 14 }}>
              <label className="label">
                Display name
                <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              {editing.kind !== 'mock' && (
                <label className="label">
                  Base URL
                  <input className="input" value={editing.baseUrl ?? ''} placeholder="https://..." onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} />
                </label>
              )}
              {editing.kind === 'openai' && (
                <label className="label">
                  API mode
                  <select className="select" value={editing.apiMode ?? 'responses'} onChange={(e) => setEditing({ ...editing, apiMode: e.target.value })}>
                    <option value="responses">Responses API</option>
                    <option value="chat_completions">Chat Completions</option>
                  </select>
                </label>
              )}
              <label className="label">
                Default model
                <input className="input" value={editing.defaultModel ?? ''} placeholder={placeholder(editing.kind)} onChange={(e) => setEditing({ ...editing, defaultModel: e.target.value })} />
              </label>
              {editing.auth.type !== 'none' && (
                <label className="label">
                  API key
                  <input
                    className="input"
                    type="password"
                    value={secret}
                    placeholder={editing.credentialRef ? 'Stored — leave blank to keep' : 'Paste key (encrypted at rest)'}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
              )}
              <div className="notice notice--info" style={{ display: 'flex', gap: 9 }}>
                <KeyRound size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Cubex only uses officially documented APIs. A consumer subscription (e.g. a chat plan) does not grant
                  third-party API access and cannot be used here.
                </span>
              </div>
            </div>
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn btn--primary" onClick={() => void save()}>Save provider</button>
              <button className="btn btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="h2">Configured</div>
        <div className="grid">
          {providers.length === 0 && (
            <div className="empty">No providers yet. Add the Mock provider above to try Cubex with no API key.</div>
          )}
          {providers.map((p) => {
            const r = results[p.id]
            return (
              <div key={p.id} className="card card--row">
                <div style={{ minWidth: 0 }}>
                  <div className="row">
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span className={`badge badge--${p.accessType === 'local' ? 'local' : 'cloud'}`}>
                      <span className="dot" />
                      {p.accessType === 'local' ? 'LOCAL' : 'CLOUD'}
                    </span>
                    {p.credentialRef && <span className="badge"><KeyRound size={11} /> key stored</span>}
                  </div>
                  <div className="muted mono" style={{ marginTop: 6 }}>
                    {p.kind} · {p.baseUrl ?? 'built-in'} {p.defaultModel ? `· ${p.defaultModel}` : ''}
                  </div>
                  {r && (
                    <div className="row" style={{ marginTop: 8, fontSize: 12.5, color: r.ok ? 'var(--ok)' : 'var(--err)' }}>
                      {r.ok ? <Check size={14} /> : <TriangleAlert size={14} />}
                      {r.message ?? (r.ok ? 'Connection OK' : 'Failed')}
                      {r.details ? <span className="muted">· {JSON.stringify(r.details)}</span> : null}
                    </div>
                  )}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => void test(p.id)} disabled={testing === p.id}>
                    {testing === p.id ? 'Testing…' : 'Test Connection'}
                  </button>
                  <button className="btn btn--danger" onClick={() => void remove(p.id)}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function placeholder(kind: string): string {
  const m: Record<string, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4',
    ollama: 'llama3.1:8b',
    lmstudio: 'local-model',
    llamacpp: 'local-model',
    mock: 'mock-large'
  }
  return m[kind] ?? 'model-id'
}
