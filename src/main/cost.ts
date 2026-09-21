import { nanoid } from 'nanoid'
import type { ModelInfo, Usage } from '@core/types'
import type { UsageRecord } from '@shared/ipc'
import { usageRepo } from './db'

/**
 * Cost tracking. Uses per-model pricing (from ModelInfo.pricing) which the user
 * can override in the model registry. Local models cost $0 in API terms.
 * Pricing is never assumed constant — it's editable metadata.
 */
export function estimateCost(usage: Usage | undefined, model: ModelInfo | undefined): { cost: number; currency: string } {
  const currency = model?.pricing?.currency ?? 'USD'
  if (!usage || !model?.pricing || model.location === 'local') return { cost: 0, currency }
  const inTok = usage.inputTokens ?? 0
  const outTok = usage.outputTokens ?? 0
  const cachedTok = usage.cachedInputTokens ?? 0
  const inputRate = model.pricing.inputPerMTok ?? 0
  const outputRate = model.pricing.outputPerMTok ?? 0
  const cachedRate = model.pricing.cachedInputPerMTok ?? inputRate
  const cost =
    ((inTok - cachedTok) * inputRate + cachedTok * cachedRate + outTok * outputRate) / 1_000_000
  return { cost: Math.max(0, cost), currency }
}

export function recordUsage(params: {
  providerId: string
  model: ModelInfo | undefined
  modelId: string
  usage: Usage | undefined
  execution: 'cloud' | 'local'
}): UsageRecord {
  const { cost, currency } = estimateCost(params.usage, params.model)
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
    currency
  }
  usageRepo.record(record)
  return record
}
