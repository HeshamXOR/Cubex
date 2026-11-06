import type { ModelPricing } from '@core/types'

/**
 * List prices for current models, in USD per million tokens, checked in November 2026 against Anthropic's pricing page for
 * Claude and against provider price lists and price trackers for the rest. They back up the synced catalog, whose entries
 * are often missing the cached-input rate, and they are what a model on an unknown gateway is estimated at when the gateway
 * publishes no price of its own. What a provider reports, and a price the person entered, always win.
 */
type Row = readonly [input: number, output: number, cachedInput?: number, cacheWrite?: number, longContext?: readonly [above: number, input: number, output: number, cachedInput?: number, cacheWrite?: number]]

const PRICES: Readonly<Record<string, Row>> = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, [100_000, 0.5, 2.5, 0.05, 0.625]],

  'gpt-6-astra': [10, 50, 1, 12.5, [272_000, 20, 75, 2, 25]],
  'gpt-6.1-sol': [2, 10, 0.1, 2.5, [272_000, 4, 15, 0.2, 5]],
  'gpt-6-sol': [2, 10, 0.2],
  'gpt-6.1-terra': [1, 5, 0.05],
  'gpt-6-luna': [0.1, 0.5, 0.01],
  'gpt-5.6-sol': [4, 20, 0.4],
  'gpt-5.6-terra': [2, 12, 0.2],
  'gpt-5.6-luna': [0.2, 1.2, 0.02],
  'gpt-5.5': [5, 30, 0.5],
  'gpt-5.4': [2.5, 15, 0.25],
  'gpt-5.4-mini': [0.75, 4.5, 0.075],
  'gpt-5.3-codex': [1.75, 14, 0.175],
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-4.1': [2, 8, 0.5],

  // DeepSeek charges half of these off-peak. The peak rate is the one that can be relied on as a ceiling.
  'deepseek-v4.1-flash': [0.3, 1.2, 0.006],
  'deepseek-v4-pro': [1.32, 3.96, 0.044],

  'glm-5.3': [1.4, 4.4, 0.26],
  'glm-5.3-flash': [0.15, 0.5, 0.03],
  'kimi-k3': [3, 15, 0.3],
  'kimi-k3.1-pro': [2, 10, 0.2],
  'kimi-k2.6': [0.65, 3.41, 0.15],
  'kimi-k2.5': [0.5, 2.5, 0.15],
  'minimax-m3': [0.3, 1.2, 0.06],
  'minimax-m3.1-flash': [0.15, 0.6, 0.015],
  'grok-4.7': [2, 6, 0.5, undefined, [200_000, 4, 12, 1]],

  'gemini-3.8-flash': [0.75, 3.75, 0.075],
  'gemini-3.7-flash': [0.75, 3.75, 0.075],
  'gemini-3.5-flash': [1.5, 9, 0.15],
  'gemini-3-flash-preview': [0.5, 3, 0.05],
  'gemini-3.1-pro-preview-customtools': [2, 12, 0.2],
  'gemini-4-argon': [2, 10, 0.1],
  'gemini-2.5-flash': [0.3, 2.5, 0.03]
}

/** The bare name of a model: a gateway may prefix it with a vendor ("anthropic/claude-sonnet-5-5"). */
const bareId = (modelId: string): string => modelId.toLowerCase().split('/').pop()!

/** The list price of a model, or undefined when it is not on this table. */
export function knownPrice(modelId: string): ModelPricing | undefined {
  const row = PRICES[bareId(modelId)]
  if (!row) return undefined
  const [input, output, cachedInput, cacheWrite, long] = row
  return {
    currency: 'USD',
    source: 'builtin',
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cachedInput !== undefined ? { cachedInputPerMTok: cachedInput } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}),
    ...(long ? {
      longContext: {
        aboveInputTokens: long[0],
        inputPerMTok: long[1],
        outputPerMTok: long[2],
        ...(long[3] !== undefined ? { cachedInputPerMTok: long[3] } : {}),
        ...(long[4] !== undefined ? { cacheWritePerMTok: long[4] } : {})
      }
    } : {})
  }
}

/**
 * A price with the cache and tier rates a catalog entry left out filled in, when it is the same list price as far as it
 * goes. A price that differs is someone's own and is left exactly as it is. A reseller's or a person's price is never touched.
 */
export function withKnownRates(pricing: ModelPricing, modelId: string): ModelPricing {
  if (pricing.source !== 'catalog') return pricing
  const known = knownPrice(modelId)
  if (!known || known.inputPerMTok !== pricing.inputPerMTok || known.outputPerMTok !== pricing.outputPerMTok) return pricing
  return {
    ...pricing,
    ...(known.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: known.cachedInputPerMTok } : {}),
    ...(known.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: known.cacheWritePerMTok } : {}),
    ...(known.longContext ? { longContext: known.longContext } : {})
  }
}
