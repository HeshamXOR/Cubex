import { ChevronRight } from 'lucide-react'
import { effortOptionsFor } from '@core/providers'
import { useStore } from '../state/store'
import { formatDuration } from '../lib/api'

/**
 * Right-hand panel: live generation Parameters, and the developer Inspector
 * (request lifecycle, timings, usage, retry/fallback trail). Secrets never
 * reach the renderer — the main process redacts before sending.
 */
export function RightPanel(): JSX.Element {
  const tab = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)

  return (
    <aside className="rpanel">
      <div className="rpanel__tabs">
        <button className={`rpanel__tab ${tab === 'params' ? 'rpanel__tab--active' : ''}`} onClick={() => setTab('params')}>
          Parameters
        </button>
        <button
          className={`rpanel__tab ${tab === 'inspector' ? 'rpanel__tab--active' : ''}`}
          onClick={() => setTab('inspector')}
        >
          Inspector
        </button>
      </div>
      <div className="rpanel__scroll">{tab === 'params' ? <Params /> : <Inspector />}</div>
    </aside>
  )
}

function Params(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const models = useStore((s) => s.models)
  const activeProviderId = useStore((s) => s.activeProviderId)
  const activeModel = useStore((s) => s.activeModel)
  const setActive = useStore((s) => s.setActive)
  const loadModels = useStore((s) => s.loadModels)
  const maxTokens = useStore((s) => s.maxTokens)
  const setMaxTokens = useStore((s) => s.setMaxTokens)
  const effort = useStore((s) => s.effort)
  const setEffort = useStore((s) => s.setEffort)
  const longContext = useStore((s) => s.longContext)
  const toggleLongContext = useStore((s) => s.toggleLongContext)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const setView = useStore((s) => s.setView)

  const providerModels = activeProviderId ? models[activeProviderId] ?? [] : []
  const model = providerModels.find((m) => m.id === activeModel)
  const activeKind = providers.find((p) => p.id === activeProviderId)?.kind
  const effortOptions = activeKind ? effortOptionsFor(activeKind) : []

  return (
    <>
      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Provider</span>
          <button className="rsec__link" onClick={() => setView('providers')}>
            Manage <ChevronRight size={13} />
          </button>
        </div>
        <select
          className="select"
          style={{ width: '100%' }}
          value={activeProviderId ?? ''}
          onChange={(e) => {
            const p = providers.find((x) => x.id === e.target.value)
            setActive(e.target.value, p?.defaultModel ?? '')
            void loadModels(e.target.value)
          }}
        >
          <option value="" disabled>
            Select provider
          </option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Model</span>
          <button className="rsec__link" onClick={() => setView('browser')}>
            Browse all <ChevronRight size={13} />
          </button>
        </div>
        <select
          className="select"
          style={{ width: '100%' }}
          value={activeModel ?? ''}
          onChange={(e) => setActive(activeProviderId!, e.target.value)}
          disabled={!activeProviderId}
        >
          <option value="" disabled>
            Select model
          </option>
          {providerModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        {model && (
          <div style={{ marginTop: 10 }}>
            <div className="field">
              <span>Context</span>
              <span className="field__v">{fmtTokens(model.contextWindow)}</span>
            </div>
            <div className="field">
              <span>Max output</span>
              <span className="field__v">{fmtTokens(model.maxOutputTokens)}</span>
            </div>
            <div className="field">
              <span>Reasoning</span>
              <span className="field__v">{model.supportsReasoning ? 'Yes' : 'No'}</span>
            </div>
            <div className="field">
              <span>Tools</span>
              <span className="field__v">{model.supportsTools ? 'Yes' : 'No'}</span>
            </div>
            {model.longContextBeta && (
              <button className="field" style={{ width: '100%' }} onClick={toggleLongContext}>
                <span>1M context (beta)</span>
                <span className={`switch ${longContext ? 'switch--on' : ''}`} />
              </button>
            )}
          </div>
        )}
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Parameters</span>
        </div>

        {effortOptions.length > 0 && (
          <>
            <div className="field" style={{ paddingBottom: 6 }}>
              <span>Reasoning effort</span>
              <span className="field__v">{effortOptions.find((e) => e.value === effort)?.label ?? '—'}</span>
            </div>
            <div className="seg">
              {effortOptions.map((e) => (
                <button
                  key={e.value}
                  className={`seg__btn ${effort === e.value ? 'seg__btn--on' : ''}`}
                  title={e.hint}
                  onClick={() => setEffort(e.value)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="field" style={{ paddingBottom: 0, marginTop: effortOptions.length > 0 ? 14 : 0 }}>
          <span>Max tokens</span>
          <input
            className="numbox"
            type="number"
            min={1}
            max={200000}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
          />
        </div>
        <input
          className="slider"
          type="range"
          min={256}
          max={32768}
          step={256}
          value={Math.min(maxTokens, 32768)}
          onChange={(e) => setMaxTokens(Number(e.target.value))}
        />
      </section>

      {settings && (
        <section className="rsec">
          <div className="rsec__head">
            <span className="rsec__title">Routing</span>
            <button className="rsec__link" onClick={() => setView('settings')}>
              Settings <ChevronRight size={13} />
            </button>
          </div>
          <Toggle
            label="Retries"
            on={settings.ai.retry.enabled}
            onChange={(v) => void saveSettings({ ai: { ...settings.ai, retry: { ...settings.ai.retry, enabled: v } } })}
          />
          <Toggle
            label="Fallback routing"
            on={settings.ai.fallbackEnabled}
            onChange={(v) => void saveSettings({ ai: { ...settings.ai, fallbackEnabled: v } })}
          />
          <Toggle
            label="Local only"
            on={settings.privacy.localOnly}
            onChange={(v) => void saveSettings({ privacy: { ...settings.privacy, localOnly: v } })}
          />
        </section>
      )}
    </>
  )
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button className="field" style={{ width: '100%' }} onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className={`switch ${on ? 'switch--on' : ''}`} />
    </button>
  )
}

function Inspector(): JSX.Element {
  const debug = useStore((s) => s.debug)
  const status = useStore((s) => s.status)
  const u = debug.usage

  return (
    <>
      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Request</span>
          <span className="badge">{status}</span>
        </div>
        <Row k="Provider" v={debug.provider ?? '—'} />
        <Row k="Model" v={debug.model ?? '—'} mono />
        <Row k="Request ID" v={debug.requestId ?? '—'} mono />
        <Row k="Stop reason" v={debug.status ?? '—'} />
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Timing</span>
        </div>
        <Row k="Time to first token" v={formatDuration(debug.ttftMs)} />
        <Row k="Total duration" v={formatDuration(debug.totalMs)} />
        <Row k="Retries" v={String(debug.retryCount)} />
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Tokens</span>
        </div>
        <Row k="Input" v={u?.inputTokens?.toLocaleString() ?? '—'} />
        <Row k="Output" v={u?.outputTokens?.toLocaleString() ?? '—'} />
        <Row k="Total" v={u?.totalTokens?.toLocaleString() ?? '—'} />
        {u?.reasoningTokens ? <Row k="Reasoning" v={u.reasoningTokens.toLocaleString()} /> : null}
        {u?.cachedInputTokens ? <Row k="Cached input" v={u.cachedInputTokens.toLocaleString()} /> : null}
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Routing trail</span>
        </div>
        {debug.gatewayTrail.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            No attempts yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {debug.gatewayTrail.map((t, i) => (
              <div key={i} className="mono" style={{ color: 'var(--text-1)', fontSize: 11.5, wordBreak: 'break-word' }}>
                {t}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rsec">
        <div className="rsec__head">
          <span className="rsec__title">Stream events</span>
        </div>
        <div className="mono muted" style={{ fontSize: 11, wordBreak: 'break-word' }}>
          {debug.events.join(' → ') || '—'}
        </div>
      </section>

      {debug.error && (
        <section className="rsec">
          <div className="rsec__head">
            <span className="rsec__title" style={{ color: 'var(--err)' }}>
              Error
            </span>
          </div>
          <div className="msg__error">
            <div style={{ fontWeight: 600 }}>
              {debug.error.category}
              {debug.error.statusCode ? ` (${debug.error.statusCode})` : ''}
            </div>
            <div style={{ color: 'var(--text-1)', fontSize: 12.5, marginTop: 5 }}>{debug.error.message}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              {debug.error.classification} · retryable: {String(debug.error.retryable)}
            </div>
          </div>
        </section>
      )}
    </>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }): JSX.Element {
  return (
    <div className="field">
      <span>{k}</span>
      <span className={`field__v ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  )
}

/** Human-friendly token count: 1000000 → "1M", 128000 → "128K". */
function fmtTokens(n: number | undefined): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
