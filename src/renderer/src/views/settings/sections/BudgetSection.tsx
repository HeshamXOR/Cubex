import { useEffect, useId, useState } from 'react'
import { MAX_BUDGET_USD } from '@shared/contextPolicy'
import { budgetState, formatUsd, parseUsdInput } from '@shared/budgetPolicy'
import type { BudgetState, UsageReport } from '@shared/ipc'
import type { BudgetSettings } from '@shared/settings'
import { api } from '../../../lib/api'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell } from '../rows'
import './contextcost.css'

type CapKey = 'dailyUsd' | 'perSessionUsd' | 'perTurnUsd'

const STATE_TEXT: Record<BudgetState, string> = { ok: '', warn: 'Near the cap', over: 'Over the cap' }

/** The field shows a whole amount without cents, and anything else with them. */
const fieldText = (amount: number | undefined): string => (amount ? (Number.isInteger(amount) ? String(amount) : amount.toFixed(2)) : '')

/** What has been spent against one cap, with a bar when the cap is set. Words carry the state as well as color. */
function Spend({ label, spent, cap }: { label: string; spent: number; cap?: number }): JSX.Element {
  const state = cap ? budgetState(spent, cap) : 'ok'
  return (
    <div className="budgetrow__spend" data-state={state}>
      <span>{label} {formatUsd(spent)}{cap ? ` of ${formatUsd(cap)}` : ''}{STATE_TEXT[state] ? `. ${STATE_TEXT[state]}.` : ''}</span>
      {cap ? <div className="budgetrow__bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} /></div> : null}
    </div>
  )
}

/** One optional dollar amount. It is saved when the field is left or Enter is pressed; an empty field means no cap. */
function CapRow({ label, hint, value, spend, onSave }: {
  label: string; hint: string; value: number | undefined; spend?: JSX.Element; onSave: (amount: number) => Promise<void>
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(fieldText(value))
  const [error, setError] = useState<string>()
  // The saved value can change underneath the field, for instance when another window edits it.
  useEffect(() => { setDraft(fieldText(value)) }, [value])

  const commit = async (): Promise<void> => {
    const parsed = parseUsdInput(draft)
    if (!parsed.ok) {
      setError(parsed.reason === 'large' ? `The most you can set is ${formatUsd(MAX_BUDGET_USD)}.` : 'Enter an amount in dollars, like 5 or 0.50. Leave it empty for no cap.')
      return
    }
    setError(undefined)
    if (parsed.usd === (value ?? 0)) { setDraft(fieldText(value)); return }
    try {
      await onSave(parsed.usd)
    } catch (reason) {
      setError(`Could not save this amount. ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  return (
    <div className="field setrow budgetrow">
      <div className="budgetrow__text">
        <label className="setrow__label" htmlFor={`${id}-amount`}>{label}</label>
        <div className="setrow__hint" id={`${id}-hint`}>{hint}</div>
        {spend}
      </div>
      <div className="budgetrow__control">
        <span className="budgetrow__prefix" aria-hidden="true">$</span>
        <input
          id={`${id}-amount`}
          className="input budgetrow__input"
          inputMode="decimal"
          placeholder="No cap"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(event) => { setDraft(event.target.value); setError(undefined) }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void commit() }
            if (event.key === 'Escape') { setDraft(fieldText(value)); setError(undefined) }
          }}
        />
      </div>
      {error && <p className="budgetrow__error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  )
}

function BudgetSettingsBody(): JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  const conversationId = useStore((state) => state.activeConversation?.id)
  const [report, setReport] = useState<UsageReport>()
  const budget = settings?.ai.budget
  // Spend is read again whenever a cap changes, so the bars always compare with the amounts on the page.
  useEffect(() => {
    let alive = true
    api.getUsageReport(conversationId).then((next) => { if (alive) setReport(next) }, () => undefined)
    return () => { alive = false }
  }, [conversationId, budget])
  if (!settings) return null

  const action = budget?.action === 'stop' ? 'stop' : 'warn'
  const spent = report?.budget.spent
  const setCap = (key: CapKey) => async (amount: number): Promise<void> => {
    const next: BudgetSettings = { ...settings.ai.budget, [key]: amount }
    await save({ ai: { ...settings.ai, budget: next } })
  }
  const setAction = async (value: string): Promise<void> => {
    await save({ ai: { ...settings.ai, budget: { ...settings.ai.budget, action: value === 'stop' ? 'stop' : 'warn' } } })
  }

  return (
    <div className="ctxsec">
      <p className="setgroup__note">Caps apply to requests sent to models with a price. A local model is never blocked. Amounts are US dollars, worked out from token counts and listed prices, so they can differ from an invoice. A change applies from your next request.</p>
      <CapRow
        label="Per day"
        hint="Everything spent since midnight, across all tasks and models."
        value={budget?.dailyUsd}
        onSave={setCap('dailyUsd')}
        spend={spent ? <Spend label="Today" spent={spent.daily} cap={budget?.dailyUsd} /> : undefined}
      />
      <CapRow
        label="Per session"
        hint="Everything one task has spent, from its first message."
        value={budget?.perSessionUsd}
        onSave={setCap('perSessionUsd')}
        spend={spent?.session !== undefined ? <Spend label="This task" spent={spent.session} cap={budget?.perSessionUsd} /> : undefined}
      />
      <CapRow
        label="Per turn"
        hint="One message and all the work Cubex does to answer it."
        value={budget?.perTurnUsd}
        onSave={setCap('perTurnUsd')}
        spend={spent?.turn !== undefined ? <Spend label="Running turn" spent={spent.turn} cap={budget?.perTurnUsd} /> : undefined}
      />
      <RowShell label="When a cap is reached" hint={action === 'stop'
        ? 'Cubex warns at 80% and ends the turn before the request that would pass the cap.'
        : 'Cubex warns at 80% and at 100%, and keeps going.'}>
        <select className="select ctxsec__action" aria-label="When a cap is reached" value={action} onChange={(event) => void setAction(event.target.value)}>
          <option value="warn">Warn and keep going</option>
          <option value="stop">Stop the turn</option>
        </select>
      </RowShell>
    </div>
  )
}

export const section: SettingsSection = { id: 'budget', title: 'Budget', page: 'context', order: 210, Component: BudgetSettingsBody }
