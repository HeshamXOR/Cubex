import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_THRESHOLD,
  autoCompactAt,
  clampThreshold,
  normalizeAiPolicy,
  normalizeBudget,
  pruneStartsAt,
  resolveCompactionPolicy
} from './contextPolicy'
import { DEFAULT_SETTINGS, type AppSettings } from './settings'

const ai = (patch: Record<string, unknown> = {}): AppSettings['ai'] => ({ ...DEFAULT_SETTINGS.ai, ...patch }) as AppSettings['ai']

describe('resolveCompactionPolicy', () => {
  it('defaults to automatic summarizing at 80 percent with pruning on', () => {
    expect(resolveCompactionPolicy(undefined)).toEqual({ auto: true, threshold: DEFAULT_COMPACTION_THRESHOLD, prune: true })
    expect(resolveCompactionPolicy({})).toEqual({ auto: true, threshold: 0.8, prune: true })
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.8)
  })

  it('lets ai.compaction.auto win over the older ai.autoCompact', () => {
    expect(resolveCompactionPolicy({ autoCompact: true, compaction: { auto: false } }).auto).toBe(false)
    expect(resolveCompactionPolicy({ autoCompact: false, compaction: { auto: true } }).auto).toBe(true)
  })

  it('treats damaged values as the safe default instead of switching summarizing off', () => {
    for (const junk of ['false', 0, null, 'no', []]) {
      expect(resolveCompactionPolicy({ autoCompact: junk }).auto).toBe(true)
      expect(resolveCompactionPolicy({ compaction: { auto: junk, prune: junk } })).toMatchObject({ auto: true, prune: true })
    }
    expect(resolveCompactionPolicy('nonsense')).toEqual({ auto: true, threshold: 0.8, prune: true })
    expect(resolveCompactionPolicy({ compaction: 'nonsense' })).toEqual({ auto: true, threshold: 0.8, prune: true })
  })

})

describe('clampThreshold', () => {
  it('keeps the slider range of 50 to 95 percent and rounds to a whole percent', () => {
    expect(clampThreshold(0.6)).toBe(0.6)
    expect(clampThreshold(0.5)).toBe(0.5)
    expect(clampThreshold(0.95)).toBe(0.95)
    expect(clampThreshold(0.2)).toBe(0.5)
    expect(clampThreshold(1.4)).toBe(0.95)
    expect(clampThreshold(0.7249)).toBe(0.72)
    expect(clampThreshold(0.7251)).toBe(0.73)
  })

})

describe('threshold math', () => {
  it('places the summarizing trigger inside the input budget', () => {
    expect(autoCompactAt(182_000, 0.8)).toBe(145_600)
    expect(autoCompactAt(200_000, 0.5)).toBe(100_000)
    expect(autoCompactAt(1_000, 0.95)).toBe(950)
  })

  it('starts pruning at 60 percent, and 10 points before a lower summarizing threshold', () => {
    expect(pruneStartsAt(0.8)).toBe(0.6)
    expect(pruneStartsAt(0.95)).toBe(0.6)
    expect(pruneStartsAt(0.7)).toBe(0.6)
    expect(pruneStartsAt(0.65)).toBe(0.55)
    expect(pruneStartsAt(0.5)).toBe(0.4)
  })
})

describe('budget normalization', () => {

  it('defaults the action to warn and keeps only valid caps', () => {
    expect(normalizeBudget({ dailyUsd: 5, perTurnUsd: 0, perSessionUsd: -1, action: 'explode' })).toEqual({ dailyUsd: 5, action: 'warn' })
    expect(normalizeBudget({ perSessionUsd: 2, action: 'stop' })).toEqual({ perSessionUsd: 2, action: 'stop' })
    expect(normalizeBudget({})).toEqual({ action: 'warn' })
  })

})

describe('normalizeAiPolicy', () => {
  it('materializes the compaction defaults and keeps both auto keys equal', () => {
    const out = normalizeAiPolicy(ai())
    expect(out.compaction).toEqual({ auto: true, threshold: 0.8, prune: true })
    expect(out.autoCompact).toBe(true)
    expect(out.budget).toBeUndefined()
  })

  it('carries an older autoCompact:false into compaction.auto, so one switch is left', () => {
    const out = normalizeAiPolicy(ai({ autoCompact: false, compaction: undefined }))
    expect(out.autoCompact).toBe(false)
    expect(out.compaction?.auto).toBe(false)
  })

  it('clamps the threshold and removes empty caps', () => {
    const out = normalizeAiPolicy(ai({ compaction: { auto: true, threshold: 0.1, prune: false }, budget: { dailyUsd: 0, perTurnUsd: 1.234, action: 'stop' } }))
    expect(out.compaction).toEqual({ auto: true, threshold: 0.5, prune: false })
    expect(out.budget).toEqual({ perTurnUsd: 1.23, action: 'stop' })
  })

  it('is idempotent and leaves every other ai key alone', () => {
    const once = normalizeAiPolicy(ai({ maxOutputTokens: 9000, budget: { dailyUsd: 4, action: 'warn' } }))
    expect(normalizeAiPolicy(once)).toEqual(once)
    expect(once.maxOutputTokens).toBe(9000)
    expect(once.retry).toEqual(DEFAULT_SETTINGS.ai.retry)
  })
})
