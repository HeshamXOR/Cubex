import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { TriangleAlert, X } from 'lucide-react'
import { formatUsd } from '@shared/budgetPolicy'
import type { BudgetMeter, UsagePeriod, UsageReport, UsageRow } from '@shared/ipc'
import { api } from '../lib/api'
import { compactTokens, plural } from '../lib/format'
import { openSettingsGroup } from '../lib/settingsLink'
import { useBusy } from '../lib/useBusy'
import { useStore } from '../state/store'
import './usage.css'

type PeriodKey = 'today' | 'week' | 'month'
const PERIODS: Array<{ key: PeriodKey; label: string; empty: string }> = [
  { key: 'today', label: 'Today', empty: 'No spend recorded today.' },
  { key: 'week', label: '7 days', empty: 'No spend recorded in the last 7 days.' },
  { key: 'month', label: '30 days', empty: 'No spend recorded in the last 30 days.' }
]
const METER_LABEL = { daily: 'Daily', session: 'This task', turn: 'This turn' } as const
const STATE_TEXT = { ok: '', warn: 'Near the cap', over: 'Over the cap' } as const
/** How many rows each list shows before the rest are folded into a count. */
const LIST_LIMIT = 6
const REFRESH_WHILE_OPEN_MS = 30_000

/** What a row's amount says: a price, or why there is none. */
function costText(row: UsageRow): string {
  if (row.unpriced) return 'No price'
  if (row.local && row.costUsd <= 0) return 'Local'
  return formatUsd(row.costUsd)
}

function Breakdown({ title, rows, total, nameOf }: { title: string; rows: UsageRow[]; total: number; nameOf: (row: UsageRow) => string }): JSX.Element | null {
  const [all, setAll] = useState(false)
  if (rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, LIST_LIMIT)
  return (
    <section className="usagepop__list" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {shown.map((row) => {
          const share = total > 0 ? Math.min(100, (row.costUsd / total) * 100) : 0
          const name = nameOf(row)
          return (
            <li key={`${row.providerId ?? ''}\n${row.id}`}>
              <div className="usagepop__line">
                <span className="usagepop__name" title={row.providerId && row.providerId !== row.id ? `${name} via ${row.providerId}` : name}>{name}</span>
                {row.estimated && <span className="usagepop__flag">estimate</span>}
                <span className={`usagepop__amount ${row.unpriced ? 'is-none' : ''}`}>{costText(row)}</span>
              </div>
              <div className="usagepop__bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>
              <div className="usagepop__sub">{plural(row.requests, 'request')}, {compactTokens(row.tokens)} tokens</div>
            </li>
          )
        })}
      </ul>
      {rows.length > LIST_LIMIT && (
        <button type="button" className="usagepop__more" onClick={() => setAll((value) => !value)}>
          {all ? 'Show fewer' : `Show ${rows.length - LIST_LIMIT} more`}
        </button>
      )}
    </section>
  )
}

function Meters({ meters }: { meters: BudgetMeter[] }): JSX.Element {
  return (
    <section className="usagepop__meters" aria-label="Budget">
      <h3>Budget</h3>
      <ul>
        {meters.map((meter) => (
          <li key={meter.scope} data-state={meter.state}>
            <div className="usagepop__line">
              <span className="usagepop__name">{METER_LABEL[meter.scope]}</span>
              <span className="usagepop__amount">{formatUsd(meter.spentUsd)} of {formatUsd(meter.limitUsd)}</span>
            </div>
            <div className="usagepop__bar usagepop__bar--meter" role="meter" aria-label={`${METER_LABEL[meter.scope]} budget`} aria-valuemin={0} aria-valuemax={meter.limitUsd} aria-valuenow={Math.min(meter.spentUsd, meter.limitUsd)} aria-valuetext={`${formatUsd(meter.spentUsd)} of ${formatUsd(meter.limitUsd)}${STATE_TEXT[meter.state] ? `, ${STATE_TEXT[meter.state].toLowerCase()}` : ''}`}>
              <span style={{ width: `${Math.min(100, (meter.spentUsd / meter.limitUsd) * 100)}%` }} />
            </div>
            {meter.state !== 'ok' && <div className="usagepop__state">{STATE_TEXT[meter.state]}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Panel({ report, period, setPeriod, nameOfProvider, onSettings, onClose, id }: {
  report: UsageReport; period: PeriodKey; setPeriod: (key: PeriodKey) => void
  nameOfProvider: (providerId: string) => string; onSettings: () => void; onClose: () => void; id: string
}): JSX.Element {
  const data: UsagePeriod = report[period]
  const spec = PERIODS.find((entry) => entry.key === period)!
  const unpriced = data.byModel.some((row) => row.unpriced)
  const estimated = data.byModel.some((row) => row.estimated)
  return (
    <>
      {/* Not a <header>: the popover is portalled to the body, where that element would become a second page banner. */}
      <div className="usagepop__head">
        <h2 id={`${id}-title`}>Usage</h2>
        <button type="button" className="usagepop__close" onClick={onClose} aria-label="Close usage"><X size={16} /></button>
      </div>
      <div className="usagepop__body">
        {/* The caps come first: where spend stands against them matters more than the breakdown below. */}
        {report.budget.meters.length > 0 && <Meters meters={report.budget.meters} />}
        <div className="seg" role="group" aria-label="Period">
          {PERIODS.map((entry) => (
            <button key={entry.key} type="button" className={`seg__btn ${entry.key === period ? 'seg__btn--on' : ''}`} aria-pressed={entry.key === period} onClick={() => setPeriod(entry.key)}>{entry.label}</button>
          ))}
        </div>
        {data.requests === 0 ? (
          <p className="usagepop__empty">{spec.empty} Cost appears here after a request to a model with a price.</p>
        ) : (
          <>
            <div className="usagepop__total">
              <span className="usagepop__figure">{formatUsd(data.costUsd)}</span>
              <span className="usagepop__sub">{plural(data.requests, 'request')}, {compactTokens(data.tokens)} tokens</span>
            </div>
            <Breakdown title="By provider" rows={data.byProvider} total={data.costUsd} nameOf={(row) => nameOfProvider(row.id)} />
            <Breakdown title="By model" rows={data.byModel} total={data.costUsd} nameOf={(row) => row.id} />
          </>
        )}
        <div className="usagepop__notes">
          <p>Amounts are token counts times listed prices, so they can differ from an invoice.</p>
          {unpriced && <p>Rows marked No price have no price data. Their usage is not in the total.</p>}
          {estimated && <p>Rows marked estimate use the built-in price table.</p>}
          <button type="button" className="usagepop__link" onClick={onSettings}>Budget settings</button>
        </div>
      </div>
    </>
  )
}

/** "Spend today" in the sidebar footer. It opens the breakdown of what was spent, and against which budget. */
export function UsageButton(): JSX.Element | null {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const conversationId = useStore((state) => state.activeConversation?.id)
  const providers = useStore((state) => state.providers)
  const busy = useBusy()
  const [report, setReport] = useState<UsageReport>()
  const [open, setOpen] = useState(false)
  const [period, setPeriod] = useState<PeriodKey>('today')
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })

  const refresh = useCallback((): void => {
    api.getUsageReport(conversationId).then(setReport, () => undefined)
  }, [conversationId])
  // A turn that just ended changed the numbers; so did opening another task, which has its own session meter.
  useEffect(() => { if (!busy) refresh() }, [busy, refresh])
  useEffect(() => {
    if (!open) return
    refresh()
    const timer = window.setInterval(refresh, REFRESH_WHILE_OPEN_MS)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const close = (returnFocus = false): void => {
    setOpen(false)
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const bounds = trigger.current?.getBoundingClientRect()
      if (!bounds) return
      const margin = 12
      const width = Math.min(340, window.innerWidth - margin * 2)
      setPosition({
        width,
        left: Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin)),
        bottom: window.innerHeight - bounds.top + 8,
        maxHeight: Math.max(160, bounds.top - margin - 8)
      })
    }
    place()
    const focusFrame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!report) return null
  const worst = report.budget.meters.some((meter) => meter.state === 'over') ? 'over' : report.budget.meters.some((meter) => meter.state === 'warn') ? 'warn' : 'ok'
  const nameOfProvider = (providerId: string): string => providers.find((provider) => provider.id === providerId)?.name ?? providerId

  return (
    <div className="usage">
      <button
        ref={trigger}
        type="button"
        className={`usage-btn ${open ? 'is-open' : ''}`}
        data-budget={worst}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Spend by provider and model, and your budget"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>Spend today</span>
        <b>{worst !== 'ok' && <TriangleAlert size={12} aria-hidden="true" />}{formatUsd(report.today.costUsd)}</b>
        {worst !== 'ok' && <span className="sr-only">{worst === 'over' ? ', over a budget cap' : ', near a budget cap'}</span>}
      </button>
      {open && createPortal(
        <div
          id={id}
          ref={panel}
          className="usagepop"
          role="dialog"
          aria-labelledby={`${id}-title`}
          tabIndex={-1}
          style={position}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null
            if (next && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) close()
          }}
        >
          <Panel
            id={id}
            report={report}
            period={period}
            setPeriod={setPeriod}
            nameOfProvider={nameOfProvider}
            onSettings={() => { close(); openSettingsGroup('budget') }}
            onClose={() => close(true)}
          />
        </div>, document.body
      )}
    </div>
  )
}
