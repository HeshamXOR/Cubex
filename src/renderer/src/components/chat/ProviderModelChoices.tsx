import { useEffect, useRef, useState } from 'react'
import { Check, Cloud, FlaskConical, RefreshCw, Server } from 'lucide-react'
import type { ProviderConfig } from '@core/types'
import { useStore } from '../../state/store'

/** One provider's models in the model menu, with a way to load or refresh the list. */
export function ProviderModelChoices({ provider, onSelect }: { provider: ProviderConfig; onSelect: () => void }): JSX.Element {
  const models = useStore((state) => state.models[provider.id])
  const activeProviderId = useStore((state) => state.activeProviderId)
  const activeModel = useStore((state) => state.activeModel)
  const loadModels = useStore((state) => state.loadModels)
  const setActive = useStore((state) => state.setActive)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef<symbol>()
  useEffect(() => {
    request.current = undefined
    setLoading(false)
    setError(undefined)
    return () => { request.current = undefined }
  }, [provider])

  const refresh = async (): Promise<void> => {
    if (request.current) return
    const owner = Symbol(provider.id)
    request.current = owner
    setLoading(true)
    setError(undefined)
    try {
      await loadModels(provider.id)
    } catch (cause) {
      if (request.current === owner) setError(cause instanceof Error ? cause.message : 'The model list could not be loaded.')
    } finally {
      if (request.current === owner) {
        request.current = undefined
        setLoading(false)
      }
    }
  }

  const choices: { id: string; displayName: string }[] = models ?? []
  const available = provider.defaultModel && !choices.some((model) => model.id === provider.defaultModel)
    ? [...choices, { id: provider.defaultModel, displayName: provider.defaultModel }] : choices
  const retry = !!error || (models !== undefined && available.length === 0)
  return (
    <div className="menu__provider" data-provider-id={provider.id}>
      <div className="menu__label">
        {provider.name}
        {provider.kind === 'mock' || provider.kind === 'mock-local'
          ? <span className="menu__provider-mode" title="Offline demo" role="img" aria-label="Offline demo"><FlaskConical size={13} aria-hidden="true" /></span>
          : provider.accessType === 'local' || ['ollama', 'lmstudio', 'llamacpp'].includes(provider.kind)
            ? <span className="menu__provider-mode" title="Local server" role="img" aria-label="Local server"><Server size={13} aria-hidden="true" /></span>
            : <span className="menu__provider-mode" title="Cloud API" role="img" aria-label="Cloud API"><Cloud size={13} aria-hidden="true" /></span>}
      </div>
      {available.length > 0 && (
        <div role="radiogroup" aria-label={`${provider.name} models`}>
          {available.map((model) => {
            const chosen = activeProviderId === provider.id && activeModel === model.id
            return (
              <button key={model.id} role="radio" aria-checked={chosen} className={`menu__item ${chosen ? 'menu__item--sel' : ''}`}
                onClick={() => { setActive(provider.id, model.id); onSelect() }}>
                <span className="menu__t">{model.displayName}</span>
                {chosen && <Check size={15} className="menu__check" />}
              </button>
            )
          })}
        </div>
      )}
      {error && <div className="menu__model-note" role="alert">{error}</div>}
      {!loading && !error && models && available.length === 0 && <div className="menu__model-note">No models returned. Load a model on the server or set a default in Providers.</div>}
      {(!models?.length || error || loading) && (
        <button className="menu__item" disabled={loading} aria-busy={loading} aria-label={`${retry ? 'Retry loading' : models ? 'Refresh' : 'Load'} models from ${provider.name}`} onClick={() => void refresh()}>
          <RefreshCw size={13} aria-hidden="true" /><span className="menu__t">{loading ? 'Loading models…' : retry ? 'Retry' : models ? 'Refresh models' : 'Load models'}</span>
        </button>
      )}
    </div>
  )
}
