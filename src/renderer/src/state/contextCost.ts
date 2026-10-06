import { create } from 'zustand'
import type { BudgetNotice, ChatEvent, CompactionResult } from '@shared/ipc'
import { compactTokens, plural } from '../lib/format'

/**
 * What context management tells the thread, kept apart from the main store: a summary or a trim that happened
 * inside a turn, a budget warning, and the numbers of the last summary. Rows come from main's `compaction` and
 * `budget` events; none of it is saved, because the saved transcript already carries what matters (the divider,
 * and the reason a turn was stopped).
 */

/** What a finished summary saved, kept for the divider that marks where it happened. */
export interface SummaryStats {
  boundaryMessageId: string
  messagesSummarized?: number
  tokensBefore?: number
  tokensAfter?: number
}

export type ContextNotice =
  | { id: string; kind: 'summary-failed'; error: string }
  | { id: string; kind: 'trimmed'; resultsTrimmed: number; tokensFreed: number }
  | { id: string; kind: 'budget'; notice: BudgetNotice }

interface Slot {
  /** The user message of the turn that raised the notices; they are hidden once the next turn begins. */
  turn?: string
  notices: ContextNotice[]
  stats?: SummaryStats
}

interface ContextCostState {
  byConversation: Record<string, Slot>
  dismiss: (conversationId: string, id: string) => void
}

export const useContextCost = create<ContextCostState>()((set) => ({
  byConversation: {},
  dismiss: (conversationId, id) => set((state) => {
    const slot = state.byConversation[conversationId]
    if (!slot) return state
    return { byConversation: { ...state.byConversation, [conversationId]: { ...slot, notices: slot.notices.filter((notice) => notice.id !== id) } } }
  })
}))

/** The part of the main store these events change: the line under the working indicator. */
type SetRun = (patch: { statusDetail: string | undefined }) => void

let counter = 0
const nextId = (kind: ContextNotice['kind']): string => `${kind}-${++counter}`

function update(conversationId: string, turn: string | undefined, change: (slot: Slot) => Slot): void {
  useContextCost.setState((state) => {
    const current = state.byConversation[conversationId] ?? { notices: [] }
    // A new turn starts clean: what the last one reported is no longer news.
    const slot: Slot = turn !== undefined && current.turn !== turn ? { ...current, turn, notices: [] } : current
    return { byConversation: { ...state.byConversation, [conversationId]: change(slot) } }
  })
}

/** A budget warning replaces an earlier one for the same cap and level, so a cap that is crossed twice shows once. */
const sameBudget = (a: ContextNotice, b: ContextNotice): boolean =>
  a.kind === 'budget' && b.kind === 'budget' && a.notice.scope === b.notice.scope && a.notice.level === b.notice.level

export function summarizingLabel(messagesSummarized: number | undefined): string {
  return messagesSummarized ? `Summarizing ${plural(messagesSummarized, 'earlier message')}` : 'Summarizing earlier messages'
}

/** Show what a `compaction` or `budget` event says. `owner` is the task the turn belongs to. */
export function applyContextCostEvent(
  event: Extract<ChatEvent, { kind: 'compaction' | 'budget' }>,
  owner: string,
  setRun: SetRun
): void {
  const turn = event.parentMessageId
  if (event.kind === 'budget') {
    const notice: ContextNotice = { id: nextId('budget'), kind: 'budget', notice: event.budget }
    update(owner, turn, (slot) => ({ ...slot, notices: [...slot.notices.filter((existing) => !sameBudget(existing, notice)), notice] }))
    return
  }
  const progress = event.compaction
  if (progress.step === 'prune') {
    if (progress.phase !== 'completed') return
    update(owner, turn, (slot) => ({
      ...slot,
      notices: [...slot.notices.filter((notice) => notice.kind !== 'trimmed'),
        { id: nextId('trimmed'), kind: 'trimmed', resultsTrimmed: progress.resultsTrimmed ?? 0, tokensFreed: progress.tokensFreed ?? 0 }]
    }))
    return
  }
  if (progress.phase === 'started') {
    // The working indicator already owns the live state of the turn; it just says what the wait is for.
    setRun({ statusDetail: summarizingLabel(progress.messagesSummarized) })
    return
  }
  setRun({ statusDetail: undefined })
  if (progress.phase === 'failed') {
    update(owner, turn, (slot) => ({
      ...slot, notices: [...slot.notices.filter((notice) => notice.kind !== 'summary-failed'), { id: nextId('summary-failed'), kind: 'summary-failed', error: progress.error ?? 'The model did not return a summary.' }]
    }))
    return
  }
  if (progress.boundaryMessageId) {
    const stats: SummaryStats = {
      boundaryMessageId: progress.boundaryMessageId,
      ...(progress.messagesSummarized !== undefined ? { messagesSummarized: progress.messagesSummarized } : {}),
      ...(progress.tokensBefore !== undefined ? { tokensBefore: progress.tokensBefore } : {}),
      ...(progress.tokensAfter !== undefined ? { tokensAfter: progress.tokensAfter } : {})
    }
    update(owner, turn, (slot) => ({ ...slot, stats }))
  }
}

/** The numbers of a summary written on demand, for the divider. */
export function noteManualSummary(conversationId: string, result: CompactionResult): void {
  if (!result.ok) return
  const stats: SummaryStats = {
    boundaryMessageId: result.boundaryMessageId,
    ...(result.messagesSummarized !== undefined ? { messagesSummarized: result.messagesSummarized } : {}),
    ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
    ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {})
  }
  update(conversationId, undefined, (slot) => ({ ...slot, stats }))
}

/** What the divider says about a summary: how many messages it replaced and, when known, what it saved. */
export function summaryHeadline(summarized: number, stats?: Pick<SummaryStats, 'tokensBefore' | 'tokensAfter'>): string {
  const base = `Summarized ${plural(summarized, 'earlier message')}`
  return stats?.tokensBefore !== undefined && stats.tokensAfter !== undefined
    ? `${base}, ${compactTokens(stats.tokensBefore)} to ${compactTokens(stats.tokensAfter)} tokens`
    : base
}

/** The notices that belong to the turn on screen. A notice with no turn (a seed, an old event) stays until dismissed. */
export function visibleNotices(slot: Slot | undefined, currentTurn: string | undefined): ContextNotice[] {
  if (!slot) return []
  return slot.turn === undefined || slot.turn === currentTurn ? slot.notices : []
}

// Design-review convenience, like the main store's: in the browser preview the rows can be driven from the console.
if (typeof window !== 'undefined' && !window.cubex) {
  ;(window as unknown as { __contextCost: typeof useContextCost }).__contextCost = useContextCost
}
