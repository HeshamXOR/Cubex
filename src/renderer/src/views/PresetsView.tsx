import { useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { ProviderConfig } from '@core/types'
import { selectableProvider, useStore } from '../state/store'
import { api } from '../lib/api'
import { plainError } from '../lib/localModels'
import type { Preset } from '../../../shared/ipc'
import type { AppSettings } from '../../../shared/settings'
import './presets.css'

type ModelsStatus = 'loading' | 'ready' | 'failed'

const NEW_BUTTON_ID = 'presets-new'
const editButtonId = (presetId: string): string => `preset-${presetId}-edit`

function focusLater(id: string): void {
  window.setTimeout(() => document.getElementById(id)?.focus(), 0)
}

/** Why a preset cannot be switched to right now, or null when it can. */
function blockedReason(preset: Preset, providers: ProviderConfig[], settings: AppSettings | undefined): string | null {
  const provider = providers.find((p) => p.id === preset.providerId)
  if (!provider) return 'Its provider was removed. Edit the preset to choose another.'
  if (!provider.enabled) return `${provider.name} is turned off. Turn it on in Providers, or edit the preset.`
  if (!selectableProvider(provider, settings)) return 'Local-only mode is on, which blocks this provider. Edit the preset to choose a local one.'
  return null
}

export function PresetsView(): JSX.Element {
  const presets = useStore((s) => s.presets)
  const providers = useStore((s) => s.providers)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const activePresetId = useStore((s) => s.activePresetId)
  const loadPresets = useStore((s) => s.loadPresets)
  const loadModels = useStore((s) => s.loadModels)
  const applyPreset = useStore((s) => s.applyPreset)
  const setView = useStore((s) => s.setView)
  const [editing, setEditing] = useState<Preset | null>(null)
  const [maxOutput, setMaxOutput] = useState('')
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('ready')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wantedProvider = useRef('')

  const fetchModels = (providerId: string): void => {
    wantedProvider.current = providerId
    setModelsStatus('loading')
    void loadModels(providerId).then(
      () => { if (wantedProvider.current === providerId) setModelsStatus('ready') },
      () => { if (wantedProvider.current === providerId) setModelsStatus('failed') }
    )
  }

  const openEditor = (preset: Preset): void => {
    setError(null)
    setConfirming(null)
    setMaxOutput(preset.params?.maxOutputTokens !== undefined ? String(preset.params.maxOutputTokens) : '')
    setEditing(preset)
    fetchModels(preset.providerId)
  }

  const startNew = (): void => {
    const first = providers[0]
    openEditor({
      id: nanoid(8),
      name: 'New preset',
      providerId: first?.id ?? '',
      model: first?.defaultModel ?? '',
      systemPrompt: '',
      params: {}
    })
  }

  const isSaved = (id: string): boolean => presets.some((p) => p.id === id)
  const triggerFor = (id: string): string => (isSaved(id) ? editButtonId(id) : NEW_BUTTON_ID)

  const closeEditor = (): void => {
    if (!editing) return
    const trigger = triggerFor(editing.id)
    setEditing(null)
    focusLater(trigger)
  }

  const pickProvider = (providerId: string): void => {
    if (!editing) return
    // A model id belongs to one provider, so the old choice would not carry over.
    setEditing({ ...editing, providerId, model: providers.find((p) => p.id === providerId)?.defaultModel ?? '' })
    fetchModels(providerId)
  }

  const save = async (): Promise<void> => {
    if (!editing || saving) return
    const limit = maxOutput.trim()
    const tokens = limit === '' ? undefined : Number(limit)
    if (tokens !== undefined && (!Number.isInteger(tokens) || tokens < 1)) {
      setError('Max output must be a whole number of tokens, 1 or more. Leave it empty for Automatic.')
      return
    }
    // Sampling temperature is not a Cubex setting; drop it from presets saved by older versions.
    const { temperature: _dropped, maxOutputTokens: _replaced, ...params } = editing.params ?? {}
    const trigger = triggerFor(editing.id)
    setError(null)
    setSaving(true)
    try {
      await api.savePreset({
        ...editing,
        name: editing.name.trim() || 'Untitled preset',
        params: tokens === undefined ? params : { ...params, maxOutputTokens: tokens }
      })
    } catch (err) {
      setError(`Could not save the preset. ${plainError(err)}`)
      setSaving(false)
      return
    }
    setEditing(null)
    setSaving(false)
    try {
      await loadPresets()
    } catch (err) {
      setError(`The preset was saved, but the list could not be refreshed. ${plainError(err)}`)
    }
    focusLater(trigger)
  }

  const remove = async (preset: Preset): Promise<void> => {
    setDeleting(preset.id)
    setError(null)
    try {
      await api.deletePreset(preset.id)
    } catch (err) {
      setError(`Could not delete ${preset.name}. ${plainError(err)}`)
      setDeleting(null)
      setConfirming(null)
      return
    }
    setDeleting(null)
    setConfirming(null)
    if (editing?.id === preset.id) setEditing(null)
    if (useStore.getState().activePresetId === preset.id) useStore.setState({ activePresetId: undefined })
    try {
      await loadPresets()
    } catch (err) {
      setError(`${preset.name} was deleted, but the list could not be refreshed. ${plainError(err)}`)
    }
    focusLater(NEW_BUTTON_ID)
  }

  const use = (id: string): void => {
    applyPreset(id)
    setView('chat')
  }

  const providerModels = editing ? models[editing.providerId] ?? [] : []
  const modelListed = editing ? providerModels.some((m) => m.id === editing.model) : false
  const providerKnown = editing ? providers.some((p) => p.id === editing.providerId) : false
  const providerName = (id: string): string => providers.find((p) => p.id === id)?.name ?? 'Removed provider'

  return (
    <div className="view presets">
      <div className="view__inner">
        <h1 className="view__title">Presets</h1>
        <p className="view__sub">
          A preset saves a provider, model and system prompt together. Use one to switch your whole setup in one step.
        </p>

        <button id={NEW_BUTTON_ID} className="btn btn--primary view__action" onClick={startNew} disabled={providers.length === 0 || editing !== null}>
          <Plus size={15} aria-hidden="true" /> New preset
        </button>

        {error && (
          <div className="callout callout--error" role="alert">
            <div className="callout__body">{error}</div>
            <button className="callout__icon" onClick={() => setError(null)} aria-label="Dismiss the error"><X size={14} aria-hidden="true" /></button>
          </div>
        )}

        {editing && (
          <section className="card presets__editor" aria-labelledby="preset-editor-title">
            <div className="presets__editor-head">
              <h2 className="h2" id="preset-editor-title">{isSaved(editing.id) ? 'Edit preset' : 'New preset'}</h2>
              <button type="button" className="btn btn--ghost btn--sm presets__close" onClick={closeEditor} aria-label="Close the preset editor">
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <form className="presets__fields" noValidate onSubmit={(e) => { e.preventDefault(); void save() }}>
              <label className="label">
                Name
                <input
                  className="input"
                  value={editing.name}
                  autoFocus
                  autoComplete="off"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <div className="presets__pair">
                <label className="label">
                  Provider
                  <select className="select" value={editing.providerId} onChange={(e) => pickProvider(e.target.value)}>
                    {!providerKnown && <option value={editing.providerId}>Removed provider</option>}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Model
                  <select
                    className="select"
                    value={editing.model}
                    aria-describedby={modelsStatus === 'failed' ? 'preset-models-hint' : undefined}
                    onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  >
                    <option value="">{modelsStatus === 'loading' ? 'Loading models…' : 'Choose a model'}</option>
                    {editing.model && !modelListed && <option value={editing.model}>{editing.model}</option>}
                    {providerModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                </label>
              </div>
              {modelsStatus === 'failed' && (
                <p className="presets__hint" id="preset-models-hint" role="status">
                  Could not load this provider's model list. Save with the model shown, or check the connection in Providers.
                </p>
              )}
              <label className="label">
                System prompt
                <textarea
                  className="textarea"
                  rows={4}
                  value={editing.systemPrompt ?? ''}
                  placeholder="You are a precise engineering assistant."
                  onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                />
              </label>
              <label className="label presets__tokens">
                Max output in tokens
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={maxOutput}
                  placeholder="Auto"
                  aria-describedby="preset-tokens-hint"
                  onChange={(e) => setMaxOutput(e.target.value)}
                />
              </label>
              <p className="presets__hint" id="preset-tokens-hint">Leave this empty to use the provider's own limit.</p>
              <div className="presets__actions">
                <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save preset'}</button>
                <button type="button" className="btn btn--ghost" onClick={closeEditor} disabled={saving}>Cancel</button>
              </div>
            </form>
          </section>
        )}

        {presets.length > 0 && (
          <>
            <div className="view__bar presets__bar">
              <h2 className="h2" id="presets-list-title">Your presets</h2>
              <span className="presets__count">{presets.length} saved</span>
            </div>
            <ul className="presets__list" aria-labelledby="presets-list-title">
              {presets.map((p) => {
                const active = activePresetId === p.id
                const blocked = blockedReason(p, providers, settings)
                const asking = confirming === p.id
                return (
                  <li key={p.id} className="presets__item">
                    <div className="presets__row">
                      <div className="presets__text">
                        <h3 className="presets__name">{p.name}</h3>
                        <p className="presets__meta">
                          {providerName(p.providerId)}, <span className="mono">{p.model || 'no model'}</span>
                          {p.params?.maxOutputTokens ? `, up to ${p.params.maxOutputTokens.toLocaleString()} output tokens` : ''}
                        </p>
                        {p.systemPrompt && <p className="presets__prompt">{p.systemPrompt}</p>}
                        {blocked && !active && <p className="presets__blocked">{blocked}</p>}
                      </div>
                      <div className="presets__buttons">
                        {active ? (
                          <button className="btn" disabled>
                            <Check size={14} aria-hidden="true" /> In use
                          </button>
                        ) : (
                          <button className="btn" onClick={() => use(p.id)} disabled={blocked !== null} aria-label={`Use preset ${p.name}`}>
                            Use preset
                          </button>
                        )}
                        <button
                          id={editButtonId(p.id)}
                          className="btn btn--ghost"
                          onClick={() => openEditor(p)}
                          disabled={editing !== null}
                          aria-label={`Edit ${p.name}`}
                        >
                          <Pencil size={14} aria-hidden="true" /> Edit
                        </button>
                        {!asking && (
                          <button className="btn btn--ghost presets__delete" onClick={() => setConfirming(p.id)} aria-label={`Delete ${p.name}`}>
                            <Trash2 size={14} aria-hidden="true" /> Delete
                          </button>
                        )}
                      </div>
                    </div>
                    {asking && (
                      <div className="confirm" role="group" aria-label={`Confirm deleting ${p.name}`}>
                        <p>Delete {p.name}? This removes the saved preset only. Your providers are not changed.</p>
                        <div className="confirm__actions">
                          <button className="btn btn--danger" onClick={() => void remove(p)} disabled={deleting === p.id}>
                            {deleting === p.id ? 'Deleting…' : 'Delete preset'}
                          </button>
                          <button className="btn btn--ghost" onClick={() => setConfirming(null)} disabled={deleting === p.id}>Keep preset</button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {presets.length === 0 && !editing && (
          providers.length === 0 ? (
            <div className="presets__empty">
              <p className="view__empty">Add a provider first, then save a preset for it.</p>
              <button className="btn" onClick={() => setView('providers')}>Open Providers</button>
            </div>
          ) : (
            <p className="view__empty">
              No presets yet. Choose New preset to save the provider, model and system prompt you use most.
            </p>
          )
        )}
      </div>
    </div>
  )
}
