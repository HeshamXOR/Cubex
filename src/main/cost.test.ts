import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo, ModelPricing, Usage } from '@core/types'

const repo = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock('./db', () => ({ usageRepo: repo }))

import { estimateCost, recordUsage } from './cost'

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'claude-sonnet-4-5', providerId: 'anthropic', displayName: 'Sonnet', location: 'cloud', capabilities: [],
    modalities: { input: ['text'], output: ['text'] }, supportsTools: true, supportsStructuredOutput: false, supportsReasoning: true,
    ...overrides
  }
}
const pricing = (extra: Partial<ModelPricing> = {}): ModelPricing => ({ currency: 'USD', inputPerMTok: 3, outputPerMTok: 15, ...extra })

describe('estimateCost, Anthropic multipliers', () => {
  // Input $3, output $15 per million tokens: reads cost 0.1x ($0.30), 5-minute writes 1.25x ($3.75), 1-hour writes 2x ($6).
  it.each<[string, Usage, number]>([
    ['plain input and output', { inputTokens: 1_000_000, outputTokens: 100_000 }, 3 + 1.5],
    ['cache read at 0.1x', { inputTokens: 1_000_000, cachedInputTokens: 800_000 }, 0.2 * 3 + 0.8 * 0.3],
    ['5-minute cache write at 1.25x', { inputTokens: 1_000_000, cacheWriteInputTokens: 400_000 }, 0.6 * 3 + 0.4 * 3.75],
    ['1-hour cache write at 2x', { inputTokens: 1_000_000, cacheWriteInputTokens: 400_000, cacheWrite1hInputTokens: 400_000 }, 0.6 * 3 + 0.4 * 6],
    ['mixed write lifetimes', { inputTokens: 1_000_000, cacheWriteInputTokens: 400_000, cacheWrite1hInputTokens: 300_000 }, 0.6 * 3 + 0.1 * 3.75 + 0.3 * 6],
    ['read, write and output together', { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteInputTokens: 200_000, outputTokens: 10_000 }, 0.3 * 3 + 0.5 * 0.3 + 0.2 * 3.75 + 0.15]
  ])('%s', (_name, usage, expected) => {
    const result = estimateCost(usage, model({ pricing: pricing() }))
    expect(result.cost).toBeCloseTo(expected, 9)
    expect(result.currency).toBe('USD')
  })

  it('treats a 1-hour share larger than the writes as the writes', () => {
    const usage: Usage = { inputTokens: 1_000_000, cacheWriteInputTokens: 100_000, cacheWrite1hInputTokens: 900_000 }
    expect(estimateCost(usage, model({ pricing: pricing() })).cost).toBeCloseTo(0.9 * 3 + 0.1 * 6, 9)
  })

  it('derives the multipliers for Claude models served through other ids such as OpenRouter', () => {
    const routed = model({ id: 'anthropic/claude-sonnet-4.5', providerId: 'openrouter', pricing: pricing() })
    expect(estimateCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }, routed).cost).toBeCloseTo(0.3, 9)
  })

  it('keeps catalog or built-in cache prices when present and derives only the 1-hour rate', () => {
    const priced = model({ pricing: pricing({ cachedInputPerMTok: 0.5, cacheWritePerMTok: 4, source: 'catalog' }) })
    expect(estimateCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }, priced).cost).toBeCloseTo(0.5, 9)
    expect(estimateCost({ inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000 }, priced).cost).toBeCloseTo(4, 9)
    expect(estimateCost({ inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000, cacheWrite1hInputTokens: 1_000_000 }, priced).cost).toBeCloseTo(6, 9)
  })
})

describe('estimateCost, other providers', () => {
  const gpt = (extra: Partial<ModelPricing> = {}): ModelInfo =>
    model({ id: 'gpt-5', providerId: 'openai', pricing: { currency: 'USD', inputPerMTok: 1.25, outputPerMTok: 10, ...extra } })

  it('prices OpenAI cached input at the cached rate', () => {
    const usage: Usage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000 }
    expect(estimateCost(usage, gpt({ cachedInputPerMTok: 0.125 })).cost).toBeCloseTo(0.0025 + 0.001 + 0.01, 9)
  })

  it('does not invent cache discounts or write surcharges for non-Anthropic models', () => {
    const usage: Usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteInputTokens: 100_000 }
    expect(estimateCost(usage, gpt()).cost).toBeCloseTo(1.25, 9)
  })

  it('costs nothing for local models even when a price is attached', () => {
    const local = model({ id: 'llama3', providerId: 'ollama', location: 'local', pricing: pricing() })
    expect(estimateCost({ inputTokens: 5_000, outputTokens: 5_000, reportedCostUsd: 1 }, local)).toMatchObject({ cost: 0, source: 'estimated' })
  })

  it('costs nothing, and says estimated, when no price is known', () => {
    expect(estimateCost({ inputTokens: 5_000, outputTokens: 5_000 }, model())).toEqual({ cost: 0, currency: 'USD', source: 'estimated' })
    expect(estimateCost(undefined, model({ pricing: pricing() })).cost).toBe(0)
    expect(estimateCost({ inputTokens: 5 }, undefined).cost).toBe(0)
  })

  it('never goes negative and survives inconsistent counts', () => {
    const odd: Usage = { inputTokens: 100, cachedInputTokens: 900_000, cacheWriteInputTokens: 50, outputTokens: Number.NaN }
    const cost = estimateCost(odd, model({ pricing: pricing() })).cost
    expect(cost).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(cost)).toBe(true)
    expect(estimateCost({ inputTokens: -5, outputTokens: -5 }, model({ pricing: pricing() })).cost).toBe(0)
  })
})

describe('estimateCost, cost source', () => {
  const usage: Usage = { inputTokens: 1_000_000 }
  it.each<[ModelPricing['source'], string]>([['catalog', 'catalog'], ['user', 'user'], ['builtin', 'estimated'], [undefined, 'estimated']])(
    'a %s price is labelled %s', (source, label) => {
      expect(estimateCost(usage, model({ pricing: pricing({ ...(source ? { source } : {}) }) })).source).toBe(label)
    })

  it('prefers the cost the provider reported and labels it reported', () => {
    const result = estimateCost({ inputTokens: 1_000_000, reportedCostUsd: 0.0421 }, model({ pricing: pricing({ source: 'catalog' }) }))
    expect(result).toEqual({ cost: 0.0421, currency: 'USD', source: 'reported' })
  })

  it('accepts a reported cost of zero but ignores junk', () => {
    expect(estimateCost({ inputTokens: 100, reportedCostUsd: 0 }, model({ pricing: pricing() }))).toMatchObject({ cost: 0, source: 'reported' })
    expect(estimateCost({ inputTokens: 1_000_000, reportedCostUsd: -1 }, model({ pricing: pricing() }))).toMatchObject({ cost: 3, source: 'estimated' })
    expect(estimateCost({ inputTokens: 1_000_000, reportedCostUsd: Number.NaN }, model({ pricing: pricing() })).source).toBe('estimated')
  })

  it('uses the price currency', () => {
    expect(estimateCost(usage, model({ pricing: pricing({ currency: 'EUR' }) })).currency).toBe('EUR')
  })
})

describe('recordUsage', () => {
  beforeEach(() => repo.record.mockClear())

  it('stores the cost source, the conversation and the cache token split', () => {
    const record = recordUsage({
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5', model: model({ pricing: pricing({ source: 'catalog' }) }), execution: 'cloud',
      conversationId: 'c1', usage: { inputTokens: 1_000_000, outputTokens: 10, cachedInputTokens: 600_000, cacheWriteInputTokens: 100_000 }
    })
    expect(record).toMatchObject({
      costSource: 'catalog', conversationId: 'c1', cacheReadTokens: 600_000, cacheWriteTokens: 100_000, inputTokens: 1_000_000, outputTokens: 10
    })
    expect(record.estimatedCost).toBeCloseTo(0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75 + 0.00015, 9)
    expect(repo.record).toHaveBeenCalledWith(record)
  })

  it('omits the optional fields when there is nothing to say', () => {
    const record = recordUsage({ providerId: 'p', modelId: 'm', model: undefined, execution: 'cloud', usage: { inputTokens: 5, outputTokens: 5 } })
    expect(record).toMatchObject({ costSource: 'estimated', estimatedCost: 0 })
    expect('conversationId' in record).toBe(false)
    expect('cacheReadTokens' in record).toBe(false)
  })
})
