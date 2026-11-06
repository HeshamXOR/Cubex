import type { ModelPricing, PricingTier } from '../../types/model'
import { endpointsFromList, type ModelEndpoint } from '../endpoints'

/**
 * New-API style gateways (and the One-API family they grew from) publish what they charge at `/api/pricing`, for each
 * model: a ratio to a base rate of $2 per million input tokens, and ratios of output and cached input to that. That is the
 * price the person is really billed through this gateway, so it beats any public price list.
 */
export interface GatewayModel {
  id: string
  pricing?: ModelPricing
  endpoints?: ModelEndpoint[]
  reasoning?: boolean
}

const BASE_USD_PER_MTOK = 2
const round = (value: number): number => Number(value.toFixed(6))
const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function ratesOf(body: string): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const match of body.matchAll(/\b(cc1h|cc|cr|p|c)\s*\*\s*([\d.]+)/g)) rates[match[1]!] = Number(match[2])
  return rates
}

interface TieredPrice {
  standard: Omit<PricingTier, 'aboveInputTokens'>
  long: PricingTier
}

const tierRates = (rates: Record<string, number>): Omit<PricingTier, 'aboveInputTokens'> => ({
  inputPerMTok: rates.p!,
  outputPerMTok: rates.c!,
  ...(rates.cr !== undefined ? { cachedInputPerMTok: rates.cr } : {}),
  ...(rates.cc !== undefined ? { cacheWritePerMTok: rates.cc } : {})
})

/**
 * Reads a tiered price: `len <= 100000 ? tier("standard", p * 0.1 + c * 0.5 + cr * 0.01) : tier("long_context", p * 0.5 + ...)`.
 * Only this one shape is read, by matching it rather than running it: the expression comes from the network.
 */
export function parseTieredPrice(expression: string): TieredPrice | undefined {
  const match = /^\s*len\s*<=\s*(\d+)\s*\?\s*tier\(\s*"[^"]*"\s*,([^)]*)\)\s*:\s*tier\(\s*"[^"]*"\s*,([^)]*)\)\s*$/.exec(expression)
  if (!match) return undefined
  const standard = ratesOf(match[2]!)
  const long = ratesOf(match[3]!)
  if (standard.p === undefined || standard.c === undefined || long.p === undefined || long.c === undefined) return undefined
  return { standard: tierRates(standard), long: { aboveInputTokens: Number(match[1]), ...tierRates(long) } }
}

function scaled<T extends Omit<PricingTier, 'aboveInputTokens'>>(tier: T, by: number): T {
  return {
    ...tier,
    inputPerMTok: round(tier.inputPerMTok * by),
    outputPerMTok: round(tier.outputPerMTok * by),
    ...(tier.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: round(tier.cachedInputPerMTok * by) } : {}),
    ...(tier.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: round(tier.cacheWritePerMTok * by) } : {})
  }
}

/** One entry of the pricing list, as what Cubex needs from it. Per-image and other flat-price models get no token price. */
function readEntry(entry: Record<string, unknown>, groupRatio: number): GatewayModel | undefined {
  if (typeof entry.model_name !== 'string' || !entry.model_name) return undefined
  const endpoints = endpointsFromList(entry.supported_endpoint_types)
  const tags = typeof entry.tags === 'string' ? entry.tags.split(',').map((tag) => tag.trim().toLowerCase()) : []
  const base: GatewayModel = {
    id: entry.model_name,
    ...(endpoints ? { endpoints } : {}),
    ...(tags.includes('reasoning') ? { reasoning: true } : {})
  }
  if (entry.quota_type !== 0 || !usable(entry.model_ratio)) return base
  const tiered = typeof entry.billing_expr === 'string' ? parseTieredPrice(entry.billing_expr) : undefined
  if (tiered) {
    return { ...base, pricing: { currency: 'USD', source: 'provider', ...scaled(tiered.standard, groupRatio), longContext: scaled(tiered.long, groupRatio) } }
  }
  const input = entry.model_ratio * BASE_USD_PER_MTOK * groupRatio
  return {
    ...base,
    pricing: {
      currency: 'USD',
      source: 'provider',
      inputPerMTok: round(input),
      outputPerMTok: round(input * (usable(entry.completion_ratio) ? entry.completion_ratio : 1)),
      ...(usable(entry.cache_ratio) ? { cachedInputPerMTok: round(input * entry.cache_ratio) } : {}),
      ...(usable(entry.create_cache_ratio) ? { cacheWritePerMTok: round(input * entry.create_cache_ratio) } : {})
    }
  }
}

/** A pricing response as a map by model id; empty when the body is not one. */
export function parseGatewayPricing(body: unknown): Map<string, GatewayModel> {
  const out = new Map<string, GatewayModel>()
  const list = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return out
  const group = (body as { group_ratio?: Record<string, unknown> }).group_ratio?.default
  const groupRatio = usable(group) && group > 0 ? group : 1
  for (const entry of list) {
    const model = entry && typeof entry === 'object' ? readEntry(entry as Record<string, unknown>, groupRatio) : undefined
    if (model) out.set(model.id, model)
  }
  return out
}

/** The list at this gateway. It is public on these gateways, so no credentials are sent; a failure just means no list. */
export async function fetchGatewayPricing(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Map<string, GatewayModel>> {
  try {
    const res = await fetchImpl(`${new URL(baseUrl).origin}/api/pricing`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
    return res.ok ? parseGatewayPricing(await res.json()) : new Map()
  } catch {
    return new Map()
  }
}
