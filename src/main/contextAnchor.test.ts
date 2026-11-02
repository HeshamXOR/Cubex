import { describe, expect, it } from 'vitest'
import { ContextAnchorStore, anchoredContextTokens } from './contextAnchor'

describe('anchoredContextTokens', () => {

  it('anchors on the reported count and adds only what came after it', () => {
    const report = { inputTokens: 12_000, estimatedAtReport: 10_000 }
    // 500 estimated tokens appended since the report, scaled by the observed 1.2x drift.
    const result = anchoredContextTokens(10_500, report)
    expect(result.basis).toBe('anchored')
    expect(result.anchorTokens).toBe(12_000)
    expect(result.appendedTokens).toBe(600)
    expect(result.tokens).toBe(12_600)
  })

  it('does not scale the appended delta down when the estimator over-counted', () => {
    // Reported below the estimate: the drift factor is clamped at 1, never below.
    const report = { inputTokens: 8_000, estimatedAtReport: 10_000 }
    const result = anchoredContextTokens(11_000, report)
    expect(result.appendedTokens).toBe(1_000)
    expect(result.tokens).toBe(9_000)
  })

  it('abandons the anchor when the conversation shrank, as after a compaction', () => {
    const report = { inputTokens: 120_000, estimatedAtReport: 100_000 }
    const result = anchoredContextTokens(20_000, report)
    expect(result).toEqual({ basis: 'estimated', tokens: 20_000 })
  })
})

describe('ContextAnchorStore', () => {
  it('records, resolves and forgets per conversation', () => {
    const store = new ContextAnchorStore()
    expect(store.resolve('a', 1_000)).toEqual({ basis: 'estimated', tokens: 1_000 })
    store.record('a', { inputTokens: 5_000, estimatedAtReport: 5_000 })
    expect(store.resolve('a', 6_000)).toMatchObject({ basis: 'anchored', tokens: 6_000 })
    expect(store.resolve('b', 6_000).basis).toBe('estimated')
    store.forget('a')
    expect(store.resolve('a', 6_000).basis).toBe('estimated')
  })

  it('takes the total input count from usage, which already includes cache reads and writes', () => {
    const store = new ContextAnchorStore()
    store.recordUsage('a', { inputTokens: 9_000, cachedInputTokens: 8_000, cacheWriteInputTokens: 500 }, 9_000)
    expect(store.resolve('a', 9_000).anchorTokens).toBe(9_000)
  })
})
