import { useEffect, useRef, useState } from 'react'
import { Check, Eye, EyeOff, Plus } from 'lucide-react'
import { MCP_ENV_LIMITS } from '../../../../shared/policy'
import { blankDraft, shouldBeSecret, toggleSecret, type EnvCheck, type EnvDraft, type EnvRowProblems } from '../../lib/envDrafts'
import { ArmedRemove } from './policyUi'

/** What the variables are for and where a secret goes, shown above the rows in the add form and in a saved server's editor. */
export function EnvHelp({ id }: { id: string }): JSX.Element {
  return (
    <p className="pform__help" id={id}>
      Variables the server reads when it starts, such as a region or a token. Turn on Secret for a credential: its value is kept in
      your operating system&apos;s credential store, not in Cubex settings, and is hidden from logs and test output.
    </p>
  )
}

function EnvRow({ draft, index, problems, idBase, disabled, focusName, onPatch, onToggle, onRemove }: {
  draft: EnvDraft
  index: number
  problems: EnvRowProblems | undefined
  idBase: string
  disabled: boolean
  focusName: boolean
  onPatch: (patch: Partial<EnvDraft>) => void
  onToggle: () => void
  onRemove: () => void
}): JSX.Element {
  const [shown, setShown] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  const id = `${idBase}-${draft.key}`
  const label = draft.name || `variable ${index + 1}`
  const nameFixed = draft.secret && (draft.saved || draft.lost)
  const keeping = draft.secret && draft.saved && !draft.replacing
  const nameError = problems?.name
  const valueError = problems?.value

  useEffect(() => { if (focusName) nameRef.current?.focus() }, [focusName])
  // After Replace, the cursor belongs in the field that is waiting for the new value.
  useEffect(() => { if (draft.replacing) valueRef.current?.focus() }, [draft.replacing])

  return (
    <li className="env__row">
      <div className="env__cell">
        {nameFixed
          ? <span className="env__name mono" id={`${id}-name`}>{draft.name}</span>
          : (
            <input
              ref={nameRef}
              id={`${id}-name`}
              className="input mono"
              placeholder="API_URL"
              value={draft.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              aria-label={`Name of variable ${index + 1}`}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${id}-name-error` : undefined}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={disabled}
            />
          )}
        {nameError && <div id={`${id}-name-error`} className="pol-field-error">{nameError}</div>}
      </div>
      <div className="env__cell">
        {keeping
          ? (
            <div className="env__kept">
              <span className="env__saved"><Check size={14} aria-hidden="true" />Saved</span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPatch({ replacing: true })} disabled={disabled} aria-label={`Replace the saved value of ${draft.name}`}>
                Replace
              </button>
            </div>
          )
          : (
            <div className="env__value">
              <input
                ref={valueRef}
                id={`${id}-value`}
                className="input mono"
                type={draft.secret && !shown ? 'password' : 'text'}
                placeholder={draft.secret ? 'Secret value' : 'Value'}
                value={draft.value}
                onChange={(e) => onPatch({ value: e.target.value })}
                aria-label={`Value of ${label}`}
                aria-invalid={!!valueError}
                aria-describedby={valueError ? `${id}-value-error` : undefined}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete={draft.secret ? 'new-password' : 'off'}
                disabled={disabled}
              />
              {draft.secret && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost env__peek"
                  onClick={() => setShown(!shown)}
                  aria-pressed={shown}
                  aria-label={`${shown ? 'Hide' : 'Show'} the value of ${label}`}
                  disabled={disabled}
                >
                  {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              )}
              {draft.secret && draft.saved && draft.replacing && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPatch({ replacing: false, value: '' })} disabled={disabled}>Keep saved</button>
              )}
            </div>
          )}
        {valueError && <div id={`${id}-value-error`} className="pol-field-error">{valueError}</div>}
        {draft.lost && <div className="pform__help">Not saved. Enter the value again.</div>}
        {shouldBeSecret(draft) && <div className="pform__help">A name like this usually holds a credential. Turn on Secret to keep the value out of Cubex settings.</div>}
      </div>
      <div className="env__cell env__cell--secret">
        <button
          type="button"
          className={`switch ${draft.secret ? 'switch--on' : ''}`}
          onClick={onToggle}
          aria-pressed={draft.secret}
          aria-label={`Keep ${label} secret`}
          disabled={disabled}
        />
        <span className="env__switch-label" aria-hidden="true">Secret</span>
      </div>
      <div className="env__cell env__cell--remove">
        {draft.saved
          ? <ArmedRemove subject={`the variable ${draft.name}`} noun="variable" onConfirm={onRemove} disabled={disabled} />
          : <button type="button" className="btn btn--sm btn--ghost" onClick={onRemove} disabled={disabled} aria-label={`Remove ${label}`}>Remove</button>}
      </div>
    </li>
  )
}

/** The rows of an MCP server's environment: name, value, and a Secret switch, with the problems of each shown under it. */
export function EnvEditor({ drafts, onChange, check, idBase, disabled = false }: {
  drafts: readonly EnvDraft[]
  onChange: (drafts: EnvDraft[]) => void
  check: EnvCheck
  /** Prefix for element ids, unique on the page. */
  idBase: string
  disabled?: boolean
}): JSX.Element {
  const [focusKey, setFocusKey] = useState<string>()
  const addRef = useRef<HTMLButtonElement>(null)
  const atLimit = drafts.length >= MCP_ENV_LIMITS.variables

  const patch = (key: string, change: Partial<EnvDraft>): void => onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)))
  const add = (): void => {
    const row = blankDraft()
    setFocusKey(row.key)
    onChange([...drafts, row])
  }
  const remove = (key: string): void => {
    onChange(drafts.filter((draft) => draft.key !== key))
    // The row that held the focus is gone.
    queueMicrotask(() => addRef.current?.focus())
  }

  return (
    <div className="env">
      {drafts.length > 0 && (
        <>
          <div className="env__head" aria-hidden="true"><span>Name</span><span>Value</span><span>Secret</span><span /></div>
          <ul className="env__rows" aria-label="Environment variables">
            {drafts.map((draft, index) => (
              <EnvRow
                key={draft.key}
                draft={draft}
                index={index}
                problems={check.rows.get(draft.key)}
                idBase={idBase}
                disabled={disabled}
                focusName={focusKey === draft.key}
                onPatch={(change) => patch(draft.key, change)}
                onToggle={() => onChange(drafts.map((row) => (row.key === draft.key ? toggleSecret(row) : row)))}
                onRemove={() => remove(draft.key)}
              />
            ))}
          </ul>
        </>
      )}
      {check.overall && <div className="pol-field-error" role="alert">{check.overall}</div>}
      <div className="env__add">
        <button ref={addRef} type="button" className="btn btn--sm" onClick={add} disabled={disabled || atLimit}>
          <Plus size={14} aria-hidden="true" />Add variable
        </button>
        {atLimit && <span className="pform__help">A server takes at most {MCP_ENV_LIMITS.variables} variables.</span>}
      </div>
    </div>
  )
}
