import { nanoid } from 'nanoid'
import type { ModelInfo, ModelPricing, Usage } from '@core/types'
import type { CostSource, UsageRecord } from '@shared/ipc'
import { usageRepo } from './db'

/**
 * Cost tracking. Uses per-model pricing (from ModelInfo.pricing), which comes from the
 * synced model catalog or from a price the user entered. Local models cost $0 in API terms.
 * Pricing is never assumed constant: it is editable metadata, and every figure says
 * where it came from (see CostSource).
 */

/** Anthropic prompt caching: reads cost 0.1x the input price, 5-minute writes 1.25x and 1-hour writes 2x. */
const ANTHROPIC_READ_MULTIPLIER = 0.1
const ANTHROPIC_WRITE_MULTIPLIER = 1.25
const ANTHROPIC_WRITE_1H_MULTIPLIER = 2

export interface CostEstimate {
  cost: number
  currency: string
  source: CostSource
}

/** A usable token count: finite and positive, else zero. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Claude models, whichever provider serves them (first party, OpenRouter, Bedrock). */
function isAnthropicModel(model: ModelInfo): boolean {
  return /claude/i.test(model.id) || /claude/i.test(model.family ?? '')
}

function sourceOf(pricing: ModelPricing): CostSource {
  if (pricing.source === 'catalog') return 'catalog'
  if (pricing.source === 'user') return 'user'
  return 'estimated'
}

export function estimateCost(usage: Usage | undefined, model: ModelInfo | undefined): CostEstimate {
  const currency = model?.pricing?.currency ?? 'USD'
  if (!usage || model?.location === 'local') return { cost: 0, currency, source: 'estimated' }
  // What the provider billed beats any estimate (OpenRouter returns it in usage.cost).
  const reported = usage.reportedCostUsd
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return { cost: reported, currency: 'USD', source: 'reported' }
  const pricing = model?.pricing
  if (!model || !pricing) return { cost: 0, currency, source: 'estimated' }

  const inputRate = pricing.inputPerMTok ?? 0
  const outputRate = pricing.outputPerMTok ?? 0
  // Only Claude models get derived cache multipliers; a catalog or user price always wins.
  const anthropic = isAnthropicModel(model)
  const readRate = pricing.cachedInputPerMTok ?? (anthropic ? inputRate * ANTHROPIC_READ_MULTIPLIER : inputRate)
  const writeRate = pricing.cacheWritePerMTok ?? (anthropic ? inputRate * ANTHROPIC_WRITE_MULTIPLIER : inputRate)
  const write1hRate = anthropic ? Math.max(writeRate, inputRate * ANTHROPIC_WRITE_1H_MULTIPLIER) : writeRate

  // inputTokens includes the cache reads and writes, so the plain input is what is left over.
  const read = count(usage.cachedInputTokens)
  const written = count(usage.cacheWriteInputTokens)
  const plain = Math.max(count(usage.inputTokens), read + written) - read - written
  const written1h = Math.min(count(usage.cacheWrite1hInputTokens), written)
  const cost =
    (plain * inputRate + read * readRate + (written - written1h) * writeRate + written1h * write1hRate +
      count(usage.outputTokens) * outputRate) / 1_000_000
  return { cost: Math.max(0, cost), currency, source: sourceOf(pricing) }
}

export function recordUsage(params: {
  providerId: string
  model: ModelInfo | undefined
  modelId: string
  usage: Usage | undefined
  execution: 'cloud' | 'local'
  conversationId?: string
}): UsageRecord {
  const { cost, currency, source } = estimateCost(params.usage, params.model)
  const cacheRead = count(params.usage?.cachedInputTokens)
  const cacheWrite = count(params.usage?.cacheWriteInputTokens)
  const record: UsageRecord = {
    id: nanoid(),
    ts: Date.now(),
    providerId: params.providerId,
    model: params.modelId,
    execution: params.execution,
    inputTokens: params.usage?.inputTokens ?? 0,
    outputTokens: params.usage?.outputTokens ?? 0,
    totalTokens: params.usage?.totalTokens ?? (params.usage?.inputTokens ?? 0) + (params.usage?.outputTokens ?? 0),
    estimatedCost: cost,
    currency,
    costSource: source,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {})
  }
  usageRepo.record(record)
  return record
}
