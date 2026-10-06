import { useCallback, useState } from 'react'
import { nanoid } from 'nanoid'
import { Plus, TriangleAlert } from 'lucide-react'
import type { ProviderConfig } from '@core/types'
import { useStore } from '../state/store'
import { useProviderChecks } from '../state/providerChecks'
import { api } from '../lib/api'
import { plainError } from '../lib/localModels'
import { connectionState } from '../lib/providerView'
import { configFromPreset, presetFor, type ProviderPreset } from '../../../shared/providerPresets'
import { ProviderChooser } from './providers/ProviderChooser'
import { ProviderEditor, type EditorFocus } from './providers/ProviderEditor'
import { ProviderRow } from './providers/ProviderRow'
import './providers.css'

interface NewProvider {
  preset: ProviderPreset
  config: ProviderConfig
  focus: EditorFocus
}

type Busy = { id: string; action: 'toggle' | 'remove' }

/** Where typing starts: the first thing a preset cannot fill in for the person. */
function focusFor(preset: ProviderPreset): EditorFocus {
  if (preset.azure) return 'resource'
  if (preset.baseUrl === '') return 'address'
  if (preset.key && preset.keyRequired) return 'key'
  return 'name'
}

/** A second provider from the same preset gets a number, so the two can be told apart in the model menu. */
function uniqueName(name: string, existing: readonly ProviderConfig[]): string {
  const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}

const focusLater = (id: string): void => {
  requestAnimationFrame(() => document.getElementById(id)?.focus())
}

/** A panel that has just opened comes into view without moving the page when it already is. */
const reveal = (el: HTMLElement | null): void => el?.scrollIntoView({ block: 'nearest' })

export function ProvidersView(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const models = useStore((s) => s.models)
  const loadProviders = useStore((s) => s.loadProviders)
  const loadModels = useStore((s) => s.loadModels)
  const { tests, notices, testing, refreshing, test, refresh, forget, dismiss } = useProviderChecks()
  const [chooserOpen, setChooserOpen] = useState(false)
  const [adding, setAdding] = useState<NewProvider | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFocus, setEditFocus] = useState<EditorFocus>('name')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [actionError, setActionError] = useState<{ title: string; body: string; retry?: () => void } | null>(null)

  const formOpen = adding !== null || editingId !== null
  const showChooser = !formOpen && (chooserOpen || providers.length === 0)

  // A new model list reaches the model menu and the default-model suggestions only after the window asks for it.
  const syncModels = useCallback((id: string): void => void loadModels(id).catch(() => undefined), [loadModels])

  const runTest = async (id: string): Promise<void> => {
    const result = await test(id)
    if (result?.ok) syncModels(id)
  }

  const runRefresh = async (id: string): Promise<void> => {
    const result = await refresh(id)
    if (result?.ok) syncModels(id)
  }

  const choose = (preset: ProviderPreset): void => {
    setChooserOpen(false)
    setConfirmRemove(null)
    setActionError(null)
    setAdding({ preset, focus: focusFor(preset), config: { ...configFromPreset(preset, nanoid(8)), name: uniqueName(preset.label, providers) } })
  }

  const closeAdding = (): void => {
    setAdding(null)
    focusLater('providers-add')
  }

  const startEdit = (provider: ProviderConfig, focus: EditorFocus = 'name'): void => {
    setChooserOpen(false)
    setConfirmRemove(null)
    setActionError(null)
    setEditFocus(focus)
    setEditingId(provider.id)
  }

  const closeEditing = (): void => {
    const id = editingId
    setEditingId(null)
    if (id) focusLater(`provider-${id}-edit`)
  }

  const refreshList = async (): Promise<void> => {
    setActionError(null)
    try {
      await loadProviders()
    } catch (err) {
      setActionError({ title: 'Could not load the providers', body: plainError(err), retry: () => void refreshList() })
    }
  }

  /** Saves a provider, then tests it, so a new connection shows whether it works without another click. */
  const save = async (config: ProviderConfig, secret: string | undefined, created: boolean): Promise<void> => {
    const saved = await api.saveProvider(config, secret)
    forget(saved.id)
    try {
      await loadProviders()
    } catch (err) {
      setAdding(null)
      setEditingId(null)
      setActionError({ title: 'The provider was saved, but the list did not update', body: plainError(err), retry: () => void refreshList() })
      return
    }
    setAdding(null)
    setEditingId(null)
    if (saved.enabled) void runTest(saved.id)
    focusLater(created ? 'providers-add' : `provider-${saved.id}-edit`)
  }

  const toggle = async (provider: ProviderConfig): Promise<void> => {
    setBusy({ id: provider.id, action: 'toggle' })
    setActionError(null)
    try {
      await api.saveProvider({ ...provider, enabled: !provider.enabled })
      forget(provider.id)
      await loadProviders()
    } catch (err) {
      setActionError({ title: `Could not turn ${provider.name} ${provider.enabled ? 'off' : 'on'}`, body: plainError(err) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (provider: ProviderConfig): Promise<void> => {
    setBusy({ id: provider.id, action: 'remove' })
    setActionError(null)
    let removed = false
    try {
      await api.deleteProvider(provider.id)
      removed = true
      forget(provider.id)
      setConfirmRemove(null)
      await loadProviders()
    } catch (err) {
      setActionError(
        removed
          ? { title: `${provider.name} was removed, but the list did not update`, body: plainError(err), retry: () => void refreshList() }
          : { title: `Could not remove ${provider.name}`, body: plainError(err) }
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="view providers">
      <div className="view__inner">
        <h1 className="view__title">Providers</h1>
        <p className="view__sub">Connect a cloud API or a local model server. Your API keys are encrypted on this device.</p>

        {providers.length > 0 && (
          <button
            id="providers-add"
            type="button"
            className="btn btn--primary view__action"
            aria-expanded={showChooser}
            onClick={() => setChooserOpen((open) => !open)}
            disabled={formOpen}
          >
            <Plus size={15} aria-hidden="true" /> Add provider
          </button>
        )}

        {actionError && (
          <div className="callout callout--error" role="alert">
            <TriangleAlert size={15} aria-hidden="true" />
            <div className="callout__body"><strong>{actionError.title}</strong>{actionError.body}</div>
            <div className="callout__actions">
              {actionError.retry && <button type="button" className="callout__action" onClick={actionError.retry}>Try again</button>}
              <button type="button" className="callout__action" onClick={() => setActionError(null)}>Dismiss</button>
            </div>
          </div>
        )}

        {showChooser && (
          <div ref={reveal}>
            <ProviderChooser
              onChoose={choose}
              {...(providers.length > 0 ? { onClose: () => { setChooserOpen(false); focusLater('providers-add') } } : {})}
            />
          </div>
        )}

        {adding && (
          <div ref={reveal} className="providers__panel">
            <ProviderEditor
              key={adding.config.id}
              initial={adding.config}
              isNew
              headingLevel={2}
              preset={adding.preset}
              focus={adding.focus}
              knownModels={[]}
              models={[]}
              onSave={(config, secret) => save(config, secret, true)}
              onClose={closeAdding}
            />
          </div>
        )}

        <section aria-labelledby="providers-list-title">
          <div className="view__bar">
            <h2 className="h2" id="providers-list-title">Your providers</h2>
            {providers.length > 0 && <span className="providers__count">{providers.length} {providers.length === 1 ? 'provider' : 'providers'}</span>}
          </div>

          {providers.length === 0 ? (
            <p className="view__empty">Providers you add appear here with their connection status. Choose one above to start.</p>
          ) : (
            <div className="providers__list">
              {providers.map((p) => {
                if (editingId === p.id) {
                  return (
                    <div key={p.id} ref={reveal}>
                      <ProviderEditor
                        key={`${p.id}-edit`}
                        initial={p}
                        isNew={false}
                        headingLevel={3}
                        preset={presetFor(p)}
                        focus={editFocus}
                        knownModels={(models[p.id] ?? []).map((m) => m.id)}
                        models={models[p.id] ?? []}
                        onSave={(config, secret) => save(config, secret, false)}
                        onClose={closeEditing}
                      />
                    </div>
                  )
                }
                const mine = busy?.id === p.id
                return (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    state={connectionState(p, { testing: !!testing[p.id], result: tests[p.id] })}
                    notice={notices[p.id]}
                    refreshing={!!refreshing[p.id]}
                    busy={mine}
                    locked={formOpen}
                    confirmingRemove={confirmRemove === p.id}
                    removing={mine && busy?.action === 'remove'}
                    onTest={() => void runTest(p.id)}
                    onRefresh={() => void runRefresh(p.id)}
                    onEdit={(focus) => startEdit(p, focus)}
                    onToggle={() => void toggle(p)}
                    onAskRemove={() => { setConfirmRemove(p.id); setActionError(null) }}
                    onCancelRemove={() => { setConfirmRemove(null); focusLater(`provider-${p.id}-remove`) }}
                    onRemove={() => void remove(p)}
                    onDismiss={() => dismiss(p.id)}
                  />
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
