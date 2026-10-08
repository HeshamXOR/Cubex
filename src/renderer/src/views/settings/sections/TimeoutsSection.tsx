import { useEffect, useId, useState } from 'react'
import { resolveTimeouts } from '@core/types'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { MAX_LIMIT_MINUTES, minutesProblem, minutesText, parseMinutes } from './timeoutInput'
import './timeouts.css'

/** One limit in whole minutes. It is saved when the field is left or Enter is pressed. */
function LimitRow({ label, hint, value, allowNone, onSave }: {
  label: string
  hint: string
  /** The stored limit in milliseconds; 0 means off. */
  value: number
  /** The overall limit can be left empty for no limit; the other two always need a number. */
  allowNone: boolean
  onSave: (ms: number) => Promise<void>
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(minutesText(value))
  const [error, setError] = useState<string>()
  // The saved value can change underneath the field, for instance when another window edits it.
  useEffect(() => { setDraft(minutesText(value)) }, [value])

  const commit = async (): Promise<void> => {
    if (draft === minutesText(value)) { setError(undefined); return }
    const parsed = parseMinutes(draft, allowNone)
    if (!parsed.ok) { setError(minutesProblem(parsed.reason, allowNone)); return }
    setError(undefined)
    if (parsed.ms === value) { setDraft(minutesText(value)); return }
    try {
      await onSave(parsed.ms)
    } catch (reason) {
      setError(`Could not save this limit. ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  return (
    <div className="field setrow limitrow">
      <div className="limitrow__text">
        <label className="setrow__label" htmlFor={`${id}-minutes`}>{label}</label>
        <div className="setrow__hint" id={`${id}-hint`}>{hint}</div>
      </div>
      <div className="limitrow__control">
        <input
          id={`${id}-minutes`}
          className="input limitrow__input"
          inputMode="numeric"
          placeholder="No limit"
          autoComplete="off"
          spellCheck={false}
          maxLength={String(MAX_LIMIT_MINUTES).length + 3}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(event) => { setDraft(event.target.value); setError(undefined) }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void commit() }
            if (event.key === 'Escape') { setDraft(minutesText(value)); setError(undefined) }
          }}
        />
        <span className="limitrow__unit" aria-hidden="true">minutes</span>
      </div>
      {error && <p className="limitrow__error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  )
}

function TimeoutSettings(): JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  if (!settings) return null

  const limits = resolveTimeouts(settings.ai.timeout)
  const setLimit = (key: 'requestMs' | 'streamIdleMs' | 'totalMs') => async (ms: number): Promise<void> => {
    await save({ ai: { ...settings.ai, timeout: { ...settings.ai.timeout, [key]: ms } } })
  }

  return (
    <div className="limitsec">
      <p className="setgroup__note">A request is stopped only when the provider has gone quiet, never because the answer is long or slow. Providers that queue requests can take minutes to begin. A change applies from your next message.</p>
      <LimitRow
        label="Wait for the first response"
        hint="How long to wait for a model to start answering. Queued or cold providers can take minutes."
        value={limits.firstResponseMs}
        allowNone={false}
        onSave={setLimit('requestMs')}
      />
      <LimitRow
        label="Stop when a response goes quiet"
        hint="How long an answer that has started may send nothing. Reasoning models can pause for minutes."
        value={limits.silenceMs}
        allowNone={false}
        onSave={setLimit('streamIdleMs')}
      />
      <LimitRow
        label="Overall limit per request"
        hint="A hard ceiling for one request, even while it is still sending. Leave it empty for no limit."
        value={limits.overallMs}
        allowNone
        onSave={setLimit('totalMs')}
      />
    </div>
  )
}

export const section: SettingsSection = { id: 'timeouts', title: 'Timeouts', page: 'models', order: 90, Component: TimeoutSettings }
