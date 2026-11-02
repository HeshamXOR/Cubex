import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BudgetNotice, ChatEvent } from '@shared/ipc'
import { applyContextCostEvent, noteManualSummary, useContextCost, visibleNotices } from './contextCost'

type Compaction = Extract<ChatEvent, { kind: 'compaction' }>
type Budget = Extract<ChatEvent, { kind: 'budget' }>

const compaction = (progress: Compaction['compaction'], turn: string | null = 'u1'): Compaction =>
  ({ streamId: 's', kind: 'compaction', compaction: progress, ...(turn ? { parentMessageId: turn } : {}) })
const budget = (notice: Partial<BudgetNotice> = {}, turn: string | null = 'u1'): Budget => ({
  streamId: 's', kind: 'budget', ...(turn ? { parentMessageId: turn } : {}),
  budget: { scope: 'daily', level: 'warn', action: 'stop', spentUsd: 4.1, limitUsd: 5, stopped: false, message: 'Daily spend is at 82%.', ...notice }
})

const setRun = vi.fn<(patch: { statusDetail: string | undefined }) => void>()
const slot = (id = 'task') => useContextCost.getState().byConversation[id]

beforeEach(() => {
  useContextCost.setState({ byConversation: {} })
  setRun.mockClear()
})

describe('a summary inside a turn', () => {
  it('says what the wait is for while it runs, and stops saying it when it ends', () => {
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'started', messagesSummarized: 8 }), 'task', setRun)
    expect(setRun).toHaveBeenLastCalledWith({ statusDetail: 'Summarizing 8 earlier messages' })
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'completed', summary: 's', boundaryMessageId: 'u5', messagesSummarized: 8 }), 'task', setRun)
    expect(setRun).toHaveBeenLastCalledWith({ statusDetail: undefined })
  })

  it('keeps the numbers for the divider that marks the new boundary', () => {
    applyContextCostEvent(compaction({
      step: 'summarize', phase: 'completed', summary: 's', boundaryMessageId: 'u5', messagesSummarized: 42, tokensBefore: 38_000, tokensAfter: 6_000
    }), 'task', setRun)
    expect(slot()?.stats).toEqual({ boundaryMessageId: 'u5', messagesSummarized: 42, tokensBefore: 38_000, tokensAfter: 6_000 })
  })

  it('reports a failure with its reason, once, and clears the wait', () => {
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'started', messagesSummarized: 8 }), 'task', setRun)
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'failed', error: 'Provider unavailable' }), 'task', setRun)
    expect(setRun).toHaveBeenLastCalledWith({ statusDetail: undefined })
    expect(slot()?.notices).toEqual([expect.objectContaining({ kind: 'summary-failed', error: 'Provider unavailable' })])
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'failed', error: 'Timed out' }), 'task', setRun)
    expect(slot()?.notices).toEqual([expect.objectContaining({ kind: 'summary-failed', error: 'Timed out' })])
  })

  it('keeps each task apart', () => {
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'failed', error: 'x' }), 'a', setRun)
    expect(slot('b')).toBeUndefined()
  })
})

describe('trimmed tool output', () => {
  it('reports what was trimmed and keeps only the latest report', () => {
    applyContextCostEvent(compaction({ step: 'prune', phase: 'completed', resultsTrimmed: 2, tokensFreed: 21_000 }), 'task', setRun)
    applyContextCostEvent(compaction({ step: 'prune', phase: 'completed', resultsTrimmed: 5, tokensFreed: 52_000 }), 'task', setRun)
    expect(slot()?.notices).toEqual([expect.objectContaining({ kind: 'trimmed', resultsTrimmed: 5, tokensFreed: 52_000 })])
    expect(setRun).not.toHaveBeenCalled()
  })

  it('ignores a prune step that did not finish', () => {
    applyContextCostEvent(compaction({ step: 'prune', phase: 'started' }), 'task', setRun)
    expect(slot()).toBeUndefined()
  })
})

describe('budget notices', () => {
  it('adds a notice per cap and level, replacing a repeat of the same one', () => {
    applyContextCostEvent(budget({ scope: 'daily', level: 'warn' }), 'task', setRun)
    applyContextCostEvent(budget({ scope: 'daily', level: 'warn', spentUsd: 4.3 }), 'task', setRun)
    applyContextCostEvent(budget({ scope: 'daily', level: 'over', stopped: true }), 'task', setRun)
    applyContextCostEvent(budget({ scope: 'turn', level: 'warn' }), 'task', setRun)
    expect(slot()?.notices.map((entry) => entry.kind === 'budget' && [entry.notice.scope, entry.notice.level, entry.notice.spentUsd])).toEqual([
      ['daily', 'warn', 4.3], ['daily', 'over', 4.1], ['turn', 'warn', 4.1]
    ])
  })

})

describe('turns', () => {
  it('starts a new turn with no notices, and keeps the last summary\'s numbers', () => {
    applyContextCostEvent(compaction({ step: 'summarize', phase: 'completed', summary: 's', boundaryMessageId: 'u5', messagesSummarized: 8 }, 'u1'), 'task', setRun)
    applyContextCostEvent(budget({}, 'u1'), 'task', setRun)
    expect(slot()?.notices).toHaveLength(1)
    applyContextCostEvent(budget({ scope: 'session' }, 'u2'), 'task', setRun)
    expect(slot()?.notices.map((entry) => entry.kind === 'budget' && entry.notice.scope)).toEqual(['session'])
    expect(slot()?.stats?.boundaryMessageId).toBe('u5')
  })

  it('shows a task\'s notices only while its latest turn is the one on screen', () => {
    applyContextCostEvent(budget({}, 'u1'), 'task', setRun)
    expect(visibleNotices(slot(), 'u1')).toHaveLength(1)
    expect(visibleNotices(slot(), 'u2')).toEqual([])
    expect(visibleNotices(slot(), undefined)).toEqual([])
    expect(visibleNotices(undefined, 'u1')).toEqual([])
  })

  it('keeps a notice that belongs to no turn until it is dismissed', () => {
    applyContextCostEvent(budget({}, null), 'task', setRun)
    expect(visibleNotices(slot(), 'anything')).toHaveLength(1)
  })

  it('removes a dismissed notice and nothing else', () => {
    applyContextCostEvent(budget({ scope: 'daily' }), 'task', setRun)
    applyContextCostEvent(budget({ scope: 'turn' }), 'task', setRun)
    const [first] = slot()!.notices
    useContextCost.getState().dismiss('task', first!.id)
    expect(slot()?.notices).toHaveLength(1)
    useContextCost.getState().dismiss('task', 'no-such-id')
    useContextCost.getState().dismiss('other', 'x')
    expect(slot()?.notices).toHaveLength(1)
  })
})

describe('a summary written on demand', () => {
  it('keeps its numbers for the divider', () => {
    noteManualSummary('task', { ok: true, summary: 's', boundaryMessageId: 'u4', messagesSummarized: 6, tokensBefore: 9_000, tokensAfter: 700 })
    expect(slot()?.stats).toEqual({ boundaryMessageId: 'u4', messagesSummarized: 6, tokensBefore: 9_000, tokensAfter: 700 })
  })

})
