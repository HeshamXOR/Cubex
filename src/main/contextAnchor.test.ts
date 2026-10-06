import { describe, expect, it } from 'vitest'
import { ContextAnchorStore, anchoredContextTokens } from './contextAnchor'

describe('anchoredContextTokens', () => {
  it('falls back to the pure estimate when nothing was reported yet', () => {
    expect(anchoredContextTokens(1_000, undefined)).toEqual({ basis: 'estimated', tokens: 1_000 })
  })

  it('anchors on the reported count and adds only what came after it', () => {
    const report = { inputTokens: 12_000, estimatedAtReport: 10_000 }
    // 500 estimated tokens appended since the report, scaled by the observed 1.2x drift.
    const result = anchoredContextTokens(10_500, report)
    expect(result.basis).toBe('anchored')
    expect(result.anchorTokens).toBe(12_000)
    expect(result.appendedTokens).toBe(600)
    expect(result.tokens).toBe(12_600)
  })

  it('never returns less than the reported count', () => {
    const report = { inputTokens: 12_000, estimatedAtReport: 10_000 }
    expect(anchoredContextTokens(10_000, report).tokens).toBe(12_000)
  })

  it('does not scale the appended delta down when the estimator over-counted', () => {
    // Reported below the estimate: the drift factor is clamped at 1, never below.
    const report = { inputTokens: 8_000, estimatedAtReport: 10_000 }
    const result = anchoredContextTokens(11_000, report)
    expect(result.appendedTokens).toBe(1_000)
    expect(result.tokens).toBe(9_000)
  })

  it('clamps an implausible drift factor', () => {
    const report = { inputTokens: 100_000, estimatedAtReport: 10_000 }
    // Raw ratio is 10x; the factor is capped so one odd report cannot explode the delta.
    expect(anchoredContextTokens(11_000, report).appendedTokens).toBe(2_000)
  })

  it('abandons the anchor when the conversation shrank, as after a compaction', () => {
    const report = { inputTokens: 120_000, estimatedAtReport: 100_000 }
    const result = anchoredContextTokens(20_000, report)
    expect(result).toEqual({ basis: 'estimated', tokens: 20_000 })
  })

  it('keeps the anchor through a shrink small enough to be pruning noise', () => {
    const report = { inputTokens: 120_000, estimatedAtReport: 100_000 }
    const result = anchoredContextTokens(99_000, report)
    expect(result.basis).toBe('anchored')
    expect(result.tokens).toBe(120_000)
  })

  it('ignores a report with no usable numbers', () => {
    expect(anchoredContextTokens(500, { inputTokens: 0, estimatedAtReport: 400 }).basis).toBe('estimated')
    expect(anchoredContextTokens(500, { inputTokens: 400, estimatedAtReport: 0 }).basis).toBe('estimated')
    expect(anchoredContextTokens(500, { inputTokens: Number.NaN, estimatedAtReport: 400 }).basis).toBe('estimated')
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

  it('sums the cache subsets only when no total was reported', () => {
    const store = new ContextAnchorStore()
    store.recordUsage('a', { cachedInputTokens: 8_000, cacheWriteInputTokens: 500 }, 7_000)
    expect(store.resolve('a', 7_000).anchorTokens).toBe(8_500)
  })

  it('records nothing when the provider reports no input tokens at all', () => {
    const store = new ContextAnchorStore()
    store.recordUsage('a', { outputTokens: 10 }, 7_000)
    store.recordUsage('b', undefined, 7_000)
    expect(store.resolve('a', 7_000).basis).toBe('estimated')
    expect(store.resolve('b', 7_000).basis).toBe('estimated')
  })

  it('keeps the newest report, so a later turn replaces an earlier anchor', () => {
    const store = new ContextAnchorStore()
    store.record('a', { inputTokens: 5_000, estimatedAtReport: 5_000 })
    store.record('a', { inputTokens: 20_000, estimatedAtReport: 18_000 })
    expect(store.resolve('a', 18_000).anchorTokens).toBe(20_000)
  })
})
