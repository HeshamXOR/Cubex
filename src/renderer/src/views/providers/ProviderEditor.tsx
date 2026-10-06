import { useId, useState, type ReactNode } from 'react'
import { Check, Plus, TriangleAlert, X } from 'lucide-react'
import type { ModelInfo, ProviderConfig } from '@core/types'
import type { ProviderPreset } from '../../../../shared/providerPresets'
import { plainError } from '../../lib/localModels'
import { declaredLongContextModels, normalizeLongContextModels } from '../../../../shared/longContext'
import { isAzure, isCustomRest, isMock, kindLabel, parseDeployments, validateProvider } from '../../lib/providerView'

export type EditorFocus = 'name' | 'address' | 'resource' | 'key'

interface EditorProps {
  initial: ProviderConfig
  isNew: boolean
  /** An editor opened in the list sits under the section heading; one opened above it is a section of its own. */
  headingLevel: 2 | 3
  /** The preset a new provider started from: it says what key the person needs and where to get it. */
  preset: ProviderPreset | undefined
  focus: EditorFocus
  /** Models the provider is known to offer, suggested for the default model. */
  knownModels: readonly string[]
  /** The same models with what their listing says about them, so the 1M list can offer the likely ones. */
  models: readonly ModelInfo[]
  /** Persists the provider. Rejecting shows the reason in the form and keeps what was typed. */
  onSave: (config: ProviderConfig, secret: string | undefined) => Promise<void>
  onClose: () => void
}

/** The window a model must report before its listing is taken as the gated 1M one rather than the ordinary window. */
const LONG_CONTEXT_FLOOR = 500_000

function Field({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: (aria: { id: string; 'aria-describedby'?: string }) => ReactNode }): JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className={`providers__field${wide ? ' providers__field--wide' : ''}`}>
      <label className="providers__label" htmlFor={id}>{label}</label>
      {children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && <p className="providers__hint" id={hintId}>{hint}</p>}
    </div>
  )
}

/** What is saved: names trimmed, deployments parsed, empty optional fields left out. */
function finalize(draft: ProviderConfig, deployments: string): ProviderConfig {
  const model = draft.defaultModel?.trim()
  const list = parseDeployments(deployments)
  const { longContextModels: _dropped, ...rest } = draft
  // The 1M list belongs to the kinds that offer models; another kind keeps none of it.
  const longContext = draft.kind === 'openai' || draft.kind === 'anthropic' || draft.kind === 'openai-compat' || draft.kind === 'gemini'
    ? normalizeLongContextModels(draft.longContextModels)
    : undefined
  const mapping = draft.kind === 'custom' && draft.mapping
    ? {
        mapping: {
          ...draft.mapping,
          promptField: draft.mapping.promptField?.trim() || undefined,
          modelField: draft.mapping.modelField?.trim() || undefined,
          responseTextPath: draft.mapping.responseTextPath?.trim() || 'text'
        }
      }
    : {}
  if (isAzure(draft)) {
    return {
      ...rest,
      name: draft.name.trim(),
      azureResource: draft.azureResource?.trim() ?? '',
      azureDeployments: list,
      apiVersion: draft.apiVersion?.trim() || 'v1',
      defaultModel: model || list[0]
    }
  }
  return {
    ...rest,
    name: draft.name.trim(),
    ...(draft.baseUrl !== undefined ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...mapping,
    ...(longContext ? { longContextModels: longContext } : {}),
    defaultModel: model || undefined
  }
}

/**
 * One form for adding and for editing a provider. The fields follow the kind: Azure OpenAI asks for a
 * resource name and deployments, the OpenAI-compatible hosts for an address, a custom JSON API for its
 * field mapping. The key is write-only: a saved key is never shown, and leaving the field empty keeps it.
 */
export function ProviderEditor({ initial, isNew, headingLevel, preset, focus, knownModels, models, onSave, onClose }: EditorProps): JSX.Element {
  const [draft, setDraft] = useState<ProviderConfig>(initial)
  const [secret, setSecret] = useState('')
  const [deployments, setDeployments] = useState((initial.azureDeployments ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [longFocus, setLongFocus] = useState<'input' | 'add'>('input')
  const headingId = useId()
  const listId = useId()
  const longListId = useId()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'

  const patch = (changes: Partial<ProviderConfig>): void => setDraft((current) => ({ ...current, ...changes }))
  const azure = isAzure(draft)
  const mock = isMock(draft.kind)
  const restMapping = isCustomRest(draft)
  const hasKey = draft.auth.type !== 'none'
  const suggestions = azure ? parseDeployments(deployments) : knownModels
  const needsLocation = (draft.kind === 'openai-compat' || draft.kind === 'custom') && !azure
  const keyPage = preset?.keyPage

  const declaredLongContext = declaredLongContextModels(draft)
  const [longDraft, setLongDraft] = useState('')
  /** The same spelling, however the person typed it: a declaration must not depend on case. */
  const spelled = (list: readonly string[], id: string): string | undefined => list.find((entry) => entry.toLowerCase() === id.trim().toLowerCase())
  const isDeclared = (id: string): boolean => spelled(declaredLongContext, id) !== undefined
  const setLongContext = (list: readonly string[], focus: 'input' | 'add' = 'input'): void => {
    patch({ longContextModels: normalizeLongContextModels(list) })
    setLongDraft('')
    setLongFocus(focus)
  }
  const addLongContext = (): void => {
    const id = longDraft.trim()
    if (!id || isDeclared(id)) return
    setLongContext([...declaredLongContext, id])
  }
  const removeLongContext = (id: string): void => setLongContext(declaredLongContext.filter((entry) => spelled([entry], id) === undefined), 'add')
  // The models a listing already reports as larger than the ordinary window are the ones a person means by 1M.
  const reportedLong = (azure ? [] : models)
    .filter((model) => (model.contextWindow ?? 0) >= LONG_CONTEXT_FLOOR && !isDeclared(model.id))
    .map((model) => model.id)

  const submit = async (): Promise<void> => {
    if (saving) return
    const config = finalize(draft, deployments)
    const problem = validateProvider(config)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(config, secret.trim() || undefined)
    } catch (err) {
      setError(plainError(err))
      setSaving(false)
    }
  }

  const keyHint = draft.credentialRef
    ? 'A key is saved on this device. Leave this empty to keep it, or paste a new one to replace it.'
    : (preset?.needs ?? (keyPage ? `Get a key from ${keyPage}.` : 'Paste the key from the provider. A chat subscription does not include an API key.'))

  return (
    <form
      className="providers__editor"
      aria-labelledby={headingId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="providers__panel-head">
        <Heading className="providers__panel-title" id={headingId}>{isNew ? `Add ${preset?.label ?? kindLabel(draft)}` : `Edit ${initial.name}`}</Heading>
        <button type="button" className="providers__close" onClick={onClose} disabled={saving} aria-label="Close the form without saving">
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <fieldset className="providers__fields" disabled={saving}>
        <legend className="sr-only">Provider details</legend>
        <Field label="Display name">
          {(aria) => (
            <input {...aria} className="input" value={draft.name} maxLength={120} autoFocus={focus === 'name'} onChange={(e) => patch({ name: e.target.value })} />
          )}
        </Field>

        {azure && (
          <Field label="Resource name" hint="The part before .openai.azure.com in your resource's address.">
            {(aria) => (
              <input {...aria} className="input" value={draft.azureResource ?? ''} placeholder="contoso-prod" spellCheck={false} autoComplete="off" autoFocus={focus === 'resource'} onChange={(e) => patch({ azureResource: e.target.value })} />
            )}
          </Field>
        )}
        {!azure && !mock && (
          <Field label="Address" hint={draft.kind === 'openai-compat' ? 'Most compatible hosts end the address with /v1.' : undefined}>
            {(aria) => (
              <input {...aria} className="input mono" value={draft.baseUrl ?? ''} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" autoFocus={focus === 'address'} onChange={(e) => patch({ baseUrl: e.target.value })} />
            )}
          </Field>
        )}

        {azure && (
          <Field wide label="Deployments" hint="Azure uses the deployment name where other providers use a model name. Separate names with commas.">
            {(aria) => (
              <textarea {...aria} className="textarea mono" rows={2} value={deployments} placeholder="gpt-4o, o3-mini" spellCheck={false} onChange={(e) => setDeployments(e.target.value)} />
            )}
          </Field>
        )}

        <Field
          label={azure ? 'Default deployment' : 'Default model'}
          hint={
            restMapping
              ? 'Required. A custom JSON endpoint does not offer a model list.'
              : azure
                ? 'Optional. The first deployment is used when this is empty.'
                : knownModels.length > 0
                  ? `${knownModels.length.toLocaleString('en-US')} known. Pick one or type a name.`
                  : 'Optional. You can pick a model in chat.'
          }
        >
          {(aria) => (
            <>
              <input {...aria} className="input mono" value={draft.defaultModel ?? ''} list={suggestions.length > 0 ? listId : undefined} placeholder={azure ? 'Your deployment name' : 'Model name'} spellCheck={false} autoComplete="off" onChange={(e) => patch({ defaultModel: e.target.value })} />
              {suggestions.length > 0 && (
                <datalist id={listId}>
                  {suggestions.map((name) => <option key={name} value={name} />)}
                </datalist>
              )}
            </>
          )}
        </Field>

        {!azure && !mock && (
          <Field
            wide
            label="1M context models"
            hint={
              <>
                Models here can use a 1M token window. They keep their ordinary window until the person turns the switch on in chat,
                where the model’s own default stays the choice. Most providers list a 1M model at 200K, so declare the ones you know
                and add whichever the provider names.
              </>
            }
          >
            {() => (
              <div className="providers__long">
                <div className="providers__long-add">
                  <input
                    className="input mono"
                    aria-label="Model that offers a 1M context window"
                    value={longDraft}
                    list={suggestions.length > 0 ? longListId : undefined}
                    placeholder="claude-sonnet-4-5-20250929"
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus={false}
                    disabled={longFocus === 'input' ? false : undefined}
                    onChange={(e) => setLongDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addLongContext()
                      }
                    }}
                  />
                  {suggestions.length > 0 && (
                    <datalist id={longListId}>
                      {suggestions.map((name) => <option key={name} value={name} />)}
                    </datalist>
                  )}
                  <button type="button" className="btn" disabled={!longDraft.trim() || isDeclared(longDraft)} onClick={addLongContext}>
                    <Plus size={14} aria-hidden="true" /> Add
                  </button>
                </div>
                {declaredLongContext.length > 0 && (
                  <ul className="providers__long-list">
                    {declaredLongContext.map((id) => (
                      <li key={id} className="providers__long-item">
                        <span className="providers__long-id mono">{id}</span>
                        <span className="providers__long-tag">1M</span>
                        <button type="button" className="providers__long-x" aria-label={`Remove ${id} from the 1M context models`} title="Remove" onClick={() => removeLongContext(id)}>
                          <X size={13} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {reportedLong.length > 0 && (
                  <div className="providers__long-suggest">
                    <span className="providers__long-suggest-label">Reported at 1M by this provider:</span>
                    {reportedLong.map((id) => (
                      <button key={id} type="button" className="providers__long-suggest-item" onClick={() => setLongContext([...declaredLongContext, id], 'add')}>
                        <Plus size={12} aria-hidden="true" /><span className="mono">{id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>
        )}

        {draft.kind === 'openai' && (
          <Field label="API mode">
            {(aria) => (
              <select {...aria} className="select" value={draft.apiMode ?? 'responses'} onChange={(e) => patch({ apiMode: e.target.value })}>
                <option value="responses">Responses API</option>
                <option value="chat_completions">Chat Completions</option>
              </select>
            )}
          </Field>
        )}
        {azure && (
          <Field label="API version" hint="Leave as v1 for current resources. Enter a dated version such as 2024-10-21 only if yours needs one.">
            {(aria) => (
              <input {...aria} className="input mono" value={draft.apiVersion ?? 'v1'} spellCheck={false} autoComplete="off" onChange={(e) => patch({ apiVersion: e.target.value })} />
            )}
          </Field>
        )}
        {needsLocation && (
          <Field label="Where it runs" hint="Local servers stay available in local-only mode.">
            {(aria) => (
              <select {...aria} className="select" value={draft.accessType === 'local' ? 'local' : 'api'} onChange={(e) => patch({ accessType: e.target.value as ProviderConfig['accessType'] })}>
                <option value="api">In the cloud</option>
                <option value="local">On this PC or my network</option>
              </select>
            )}
          </Field>
        )}

        {hasKey && (
          <Field wide label="API key" hint={keyHint}>
            {(aria) => (
              <input {...aria} className="input mono" type="password" name="provider-key" value={secret} autoComplete="new-password" spellCheck={false} autoFocus={focus === 'key'} placeholder={draft.credentialRef ? 'Saved. Paste a new key to replace it.' : 'Paste your key'} onChange={(e) => setSecret(e.target.value)} />
            )}
          </Field>
        )}

        {draft.kind === 'custom' && (
          <div className="providers__mapping">
            <Field label="Request and response format">
              {(aria) => (
                <select {...aria} className="select" value={draft.mapping?.shape ?? 'rest'} onChange={(e) => patch({ mapping: { ...draft.mapping, shape: e.target.value as 'rest' | 'openai' | 'anthropic' } })}>
                  <option value="rest">Custom JSON</option>
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic Messages</option>
                </select>
              )}
            </Field>
            {restMapping && (
              <>
                <Field label="Prompt field">
                  {(aria) => <input {...aria} className="input mono" value={draft.mapping?.promptField ?? ''} placeholder="prompt" spellCheck={false} onChange={(e) => patch({ mapping: { ...draft.mapping, promptField: e.target.value } })} />}
                </Field>
                <Field label="Response text path" hint="Use dots for nested values, for example result.text.">
                  {(aria) => <input {...aria} className="input mono" value={draft.mapping?.responseTextPath ?? ''} placeholder="text" spellCheck={false} onChange={(e) => patch({ mapping: { ...draft.mapping, responseTextPath: e.target.value } })} />}
                </Field>
                <Field label="Model field" hint="Optional. Leave empty if the endpoint takes no model.">
                  {(aria) => <input {...aria} className="input mono" value={draft.mapping?.modelField ?? ''} placeholder="model" spellCheck={false} onChange={(e) => patch({ mapping: { ...draft.mapping, modelField: e.target.value } })} />}
                </Field>
              </>
            )}
          </div>
        )}
      </fieldset>

      {error && (
        <div className="callout callout--error providers__form-error" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <div className="callout__body"><strong>{isNew ? 'Could not add the provider' : 'Could not save the changes'}</strong>{error}</div>
        </div>
      )}

      <div className="providers__form-actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : <><Check size={15} aria-hidden="true" /> {isNew ? 'Save provider' : 'Save changes'}</>}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancel</button>
      </div>
    </form>
  )
}
