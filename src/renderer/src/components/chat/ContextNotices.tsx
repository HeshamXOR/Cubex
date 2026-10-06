import { useMemo } from 'react'
import { CircleDollarSign, Shrink, TriangleAlert, X } from 'lucide-react'
import { budgetScopeName, formatUsd, isBudgetMessage } from '@shared/budgetPolicy'
import type { BudgetNotice } from '@shared/ipc'
import { useStore } from '../../state/store'
import { summarizingLabel, useContextCost, visibleNotices, type ContextNotice } from '../../state/contextCost'
import { compactTokens, plural } from '../../lib/format'
import { useBusy } from '../../lib/useBusy'
import { openSettingsGroup } from '../../lib/settingsLink'
import { ActivityRow } from '../../status/ActivityRow'
import '../context.css'

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

function budgetHeadline(notice: BudgetNotice): string {
  const scope = budgetScopeName(notice.scope)
  if (notice.level === 'warn') return `${capitalize(scope)} budget at ${Math.floor((notice.spentUsd / notice.limitUsd) * 100)}%`
  return notice.stopped ? `Stopped by the ${scope} budget` : `${capitalize(scope)} budget reached`
}

/** A turn that was stopped already says why in its reply, so the row adds the figures and the way to change the cap. */
function budgetDetail(notice: BudgetNotice): string {
  return notice.stopped
    ? `${formatUsd(notice.spentUsd)} spent of the ${formatUsd(notice.limitUsd)} ${budgetScopeName(notice.scope)} budget.`
    : notice.message
}

function Dismiss({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return <button type="button" className="callout__icon" aria-label={label} title={label} onClick={onClick}><X size={14} aria-hidden="true" /></button>
}

function NoticeRow({ conversationId, notice, busy, onSummarize }: {
  conversationId: string; notice: ContextNotice; busy: boolean; onSummarize: () => void
}): JSX.Element {
  const dismiss = useContextCost((state) => state.dismiss)
  const remove = (): void => dismiss(conversationId, notice.id)
  if (notice.kind === 'budget') {
    return (
      <div className="callout callout--warn" role="status">
        <CircleDollarSign size={14} aria-hidden="true" />
        <div className="callout__body"><strong>{budgetHeadline(notice.notice)}</strong>{budgetDetail(notice.notice)}</div>
        <div className="callout__actions">
          <button type="button" className="callout__action" onClick={() => openSettingsGroup('budget')}>Budget settings</button>
          <Dismiss label="Dismiss budget notice" onClick={remove} />
        </div>
      </div>
    )
  }
  if (notice.kind === 'trimmed') {
    return (
      <div className="callout" role="status">
        <Shrink size={14} aria-hidden="true" />
        <div className="callout__body">
          <strong>Trimmed {plural(notice.resultsTrimmed, 'old tool result')}</strong>
          About {compactTokens(notice.tokensFreed)} tokens freed. The model can run a tool again if it needs its output.
        </div>
        <div className="callout__actions"><Dismiss label="Dismiss trim notice" onClick={remove} /></div>
      </div>
    )
  }
  return (
    <div className="callout callout--warn" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      <div className="callout__body">
        <strong>Could not summarize earlier messages</strong>
        {sentence(notice.error)} This turn used the full conversation instead.
      </div>
      <div className="callout__actions">
        <button type="button" className="callout__action" disabled={busy} onClick={onSummarize}>Summarize again</button>
        <Dismiss label="Dismiss summary notice" onClick={remove} />
      </div>
    </div>
  )
}

/**
 * Context and cost rows at the end of the thread: the summary being written on demand, one that failed, old tool
 * output that was trimmed, and budget warnings. They belong to the latest turn and go once the next one starts.
 */
export function ContextNotices({ conversationId, turn }: { conversationId?: string; turn?: string }): JSX.Element | null {
  const busy = useBusy()
  const slot = useContextCost((state) => (conversationId ? state.byConversation[conversationId] : undefined))
  const compacting = useStore((state) => !!conversationId && state.compactingId === conversationId)
  const compactError = useStore((state) => state.compactError)
  const compactActive = useStore((state) => state.compactActive)
  const dismissCompactError = useStore((state) => state.dismissCompactError)
  const startedAt = useMemo(() => Date.now(), [compacting])
  const notices = visibleNotices(slot, turn)

  if (!conversationId || (!compacting && !compactError && notices.length === 0)) return null
  const blocked = compactError ? isBudgetMessage(compactError) : false
  return (
    <div className="ctxnotes">
      {compacting && <ActivityRow state="working" label={summarizingLabel(undefined)} startedAt={startedAt} iconSize={14} />}
      {compactError && (
        <div className="callout callout--error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div className="callout__body">
            <strong>Could not summarize earlier messages</strong>
            {sentence(compactError)}{blocked ? '' : ' Nothing changed, so new requests still carry the full conversation.'}
          </div>
          <div className="callout__actions">
            {blocked
              ? <button type="button" className="callout__action" onClick={() => openSettingsGroup('budget')}>Budget settings</button>
              : <button type="button" className="callout__action" disabled={busy || compacting} onClick={() => void compactActive()}>Try again</button>}
            <Dismiss label="Dismiss summary error" onClick={dismissCompactError} />
          </div>
        </div>
      )}
      {notices.map((notice) => (
        <NoticeRow key={notice.id} conversationId={conversationId} notice={notice} busy={busy} onSummarize={() => void compactActive()} />
      ))}
    </div>
  )
}
