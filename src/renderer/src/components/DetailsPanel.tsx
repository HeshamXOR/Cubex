import { ChevronRight } from 'lucide-react'
import { effortOptionsFor, normalizeEffortFor, reasoningSupport } from '@core/providers'
import { selectableProvider, useStore } from '../state/store'
import { formatDuration } from '../lib/api'
import { compactTokens } from '../lib/format'
import { resolveOutputLimit } from '../../../shared/outputLimit'
import { EffortSlider } from './chat/EffortSlider'

const OUTPUT_SLIDER_STEP = 1024
/** The slider's top when the model does not say how much it can write. */
const DEFAULT_OUTPUT_CEILING = 65_536
const MAX_OUTPUT_CEILING = 131_072

/**
 * Model, generation parameters and the request inspector. Secrets never reach the
 * renderer: the main process redacts before sending.
 */
export function DetailsPanel(): JSX.Element {
  return (
    <div className="rdetails">
      <Params />
      <Inspector />
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: JSX.Element; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rsec">
      <div className="rsec__head">
        <h2 className="rsec__title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
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

  const availableProviders = providers.filter((provider) => selectableProvider(provider, settings))
  const providerModels = activeProviderId ? models[activeProviderId] ?? [] : []
  // The list may not have loaded, or the request may have failed. The model in use,
  // and the provider's default, still have to show instead of leaving the select blank.
  const providerDefault = providers.find((p) => p.id === activeProviderId)?.defaultModel
  const modelChoices = providerModels.map((m) => ({ id: m.id, name: m.displayName }))
  for (const id of [activeModel, providerDefault]) {
    if (id && !modelChoices.some((choice) => choice.id === id)) modelChoices.push({ id, name: id })
  }
  const model = providerModels.find((m) => m.id === activeModel)
  const activeKind = providers.find((p) => p.id === activeProviderId)?.kind
  const effortModel = model ?? { id: activeModel ?? '' }
  const effortOptions = activeKind ? effortOptionsFor(activeKind, effortModel) : []
  const selectedEffort = activeKind ? normalizeEffortFor(activeKind, effort, effortModel) : undefined
  const reasoning = model ? reasoningSupport(activeKind, model) : 'no'
  // What Automatic means for this model, and the most a person can ask of it.
  const autoOutput = resolveOutputLimit(undefined, model?.maxOutputTokens)
  const outputCeiling = Math.max(autoOutput, Math.min(model?.maxOutputTokens ?? DEFAULT_OUTPUT_CEILING, MAX_OUTPUT_CEILING))

  return (
    <>
      <Section
        title="Model"
        action={<button className="rsec__link" onClick={() => setView('providers')}>Providers<ChevronRight size={13} /></button>}
      >
        <select
          className="select rfull"
          aria-label="Provider"
          value={activeProviderId ?? ''}
          onChange={(event) => {
            const provider = providers.find((candidate) => candidate.id === event.target.value)
            setActive(event.target.value, provider?.defaultModel ?? '')
            void loadModels(event.target.value)
          }}
        >
          <option value="" disabled>
            {availableProviders.length === 0 && settings?.privacy.localOnly ? 'No local providers enabled' : 'Select provider'}
          </option>
          {availableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        <select
          className="select rfull"
          style={{ marginTop: 8 }}
          aria-label="Model"
          value={activeModel ?? ''}
          onChange={(event) => setActive(activeProviderId!, event.target.value)}
          disabled={!activeProviderId}
        >
          <option value="" disabled>Select model</option>
          {modelChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select>
        {model && (
          <div className="rfacts">
            <div className="field"><span>Context window</span><span className="field__v">{model.contextWindow ? compactTokens(model.contextWindow) : '—'}</span></div>
            <div className="field"><span>Max output</span><span className="field__v">{model.maxOutputTokens ? compactTokens(model.maxOutputTokens) : '—'}</span></div>
            <div className="field"><span>Reasoning</span><span className="field__v">{reasoning === 'yes' ? 'Yes' : reasoning === 'no' ? 'No' : 'Not reported'}</span></div>
            <div className="field"><span>Tools</span><span className="field__v">{model.supportsTools ? 'Yes' : 'No'}</span></div>
            {model.longContextBeta && (
              <button className="field rtoggle" onClick={toggleLongContext} role="switch" aria-checked={longContext}>
                <span>1M context (beta)</span>
                <span className={`switch ${longContext ? 'switch--on' : ''}`} />
              </button>
            )}
          </div>
        )}
      </Section>

      <Section title="Generation">
        {effortOptions.length > 0 && <EffortSlider options={effortOptions} selected={selectedEffort} onChange={setEffort} />}
        <div className="field" style={{ marginTop: effortOptions.length > 0 ? 10 : 0 }}>
          <span>Max output tokens</span>
          <input
            className="numbox"
            type="number"
            aria-label="Max output tokens"
            min={1}
            max={outputCeiling}
            placeholder="Auto"
            value={maxTokens > 0 ? maxTokens : ''}
            onChange={(event) => setMaxTokens(event.target.value === '' ? 0 : Number(event.target.value))}
          />
        </div>
        <input
          className="slider"
          type="range"
          aria-label="Max output tokens, slider"
          min={OUTPUT_SLIDER_STEP}
          max={outputCeiling}
          step={OUTPUT_SLIDER_STEP}
          value={Math.min(Math.max(maxTokens > 0 ? maxTokens : autoOutput, OUTPUT_SLIDER_STEP), outputCeiling)}
          style={{ ['--p' as string]: `${Math.min(100, Math.max(0, (((maxTokens > 0 ? maxTokens : autoOutput) - OUTPUT_SLIDER_STEP) / (outputCeiling - OUTPUT_SLIDER_STEP)) * 100))}%` }}
          onChange={(event) => setMaxTokens(Number(event.target.value))}
        />
        <p className="rhint">
          {maxTokens > 0
            ? <>A limit you set. <button className="rsec__link" onClick={() => setMaxTokens(0)}>Use Automatic</button></>
            : `Automatic: up to ${compactTokens(autoOutput)} tokens per reply, so a whole file fits in one tool call.`}
        </p>
      </Section>

      {settings && (
        <Section title="Routing" action={<button className="rsec__link" onClick={() => setView('settings')}>Settings<ChevronRight size={13} /></button>}>
          <Toggle
            label="Retries"
            on={settings.ai.retry.enabled}
            onChange={(value) => void saveSettings({ ai: { ...settings.ai, retry: { ...settings.ai.retry, enabled: value } } })}
          />
          <Toggle
            label="Local only"
            hint="Restricts the next model request, retry, or fallback to local providers. Does not stop an active request or block tools, downloads, or MCP network access."
            on={settings.privacy.localOnly}
            onChange={(value) => void saveSettings({ privacy: { ...settings.privacy, localOnly: value } })}
          />
        </Section>
      )}
    </>
  )
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button className="field rtoggle" title={hint} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className={`switch ${on ? 'switch--on' : ''}`} />
    </button>
  )
}

function Inspector(): JSX.Element {
  const debug = useStore((s) => s.debug)
  const status = useStore((s) => s.status)
  const usage = debug.usage

  return (
    <details className="rinspect">
      <summary>
        <ChevronRight size={14} className="rinspect__chev" aria-hidden="true" />
        <span>Last request</span>
        <span className="badge">{status}</span>
      </summary>

      <Section title="Request">
        <Row k="Provider" v={debug.provider ?? '—'} />
        <Row k="Model" v={debug.model ?? '—'} mono />
        <Row k="Request ID" v={debug.requestId ?? '—'} mono />
        <Row k="Stop reason" v={debug.status ?? '—'} />
      </Section>

      <Section title="Timing">
        <Row k="Time to first token" v={formatDuration(debug.ttftMs)} />
        <Row k="Total duration" v={formatDuration(debug.totalMs)} />
        <Row k="Retries" v={String(debug.retryCount)} />
      </Section>

      <Section title="Tokens">
        <Row k="Input" v={usage?.inputTokens?.toLocaleString() ?? '—'} />
        <Row k="Output" v={usage?.outputTokens?.toLocaleString() ?? '—'} />
        <Row k="Total" v={usage?.totalTokens?.toLocaleString() ?? '—'} />
        {usage?.reasoningTokens ? <Row k="Reasoning" v={usage.reasoningTokens.toLocaleString()} /> : null}
        {usage?.cachedInputTokens ? <Row k="Cached input" v={usage.cachedInputTokens.toLocaleString()} /> : null}
      </Section>

      <Section title="Routing trail">
        {debug.gatewayTrail.length === 0 ? (
          <p className="rhint">No attempts yet.</p>
        ) : (
          <div className="rtrail">{debug.gatewayTrail.map((entry, index) => <div key={index} className="mono">{entry}</div>)}</div>
        )}
      </Section>

      <Section title="Stream events">
        <p className="rhint mono">{debug.events.join(' → ') || '—'}</p>
      </Section>

      {debug.error && (
        <Section title="Error">
          <div className="rerror">
            <strong>{debug.error.category}{debug.error.statusCode ? ` (${debug.error.statusCode})` : ''}</strong>
            <p>{debug.error.message}</p>
            <p className="rhint">{debug.error.classification}, retryable: {String(debug.error.retryable)}</p>
          </div>
        </Section>
      )}
    </details>
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
