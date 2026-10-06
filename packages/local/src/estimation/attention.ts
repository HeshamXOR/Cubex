/**
 * Attention shape and KV-cache math. The cache holds one key and one value
 * vector per layer per token:
 *
 *   bytes = 2 (K and V) x layers x kvHeads x headDim x bytesPerElement x tokens
 *
 * Grouped-query attention (GQA) shows up as kvHeads smaller than the number of
 * query heads, which is why a modern 8B model needs a quarter of the cache of an
 * older multi-head one. Sliding-window layers only keep their window.
 */

export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'

export const KV_CACHE_TYPES: readonly KvCacheType[] = ['f16', 'q8_0', 'q4_0']

/** Bytes per stored element: f16 is 2; q8_0 is 34 bytes per 32 values; q4_0 is 18 per 32. */
const BYTES_PER_ELEMENT: Record<KvCacheType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 }

/** Slack llama.cpp keeps beyond the window for a batch of in-flight tokens. */
const SWA_BATCH_SLACK = 512

export interface Attention {
  layers: number
  kvHeads: number
  headDim: number
  /** How many layers only attend to a sliding window (the rest attend to everything). */
  slidingLayers?: number
  /** The window, in tokens, for those layers. */
  slidingWindow?: number
}

/** Bytes of cache per token if every layer were global attention. */
export function kvBytesPerToken(attention: Attention, type: KvCacheType = 'f16'): number {
  return Math.round(2 * attention.layers * attention.kvHeads * attention.headDim * BYTES_PER_ELEMENT[type])
}

export function kvCacheBytes(attention: Attention, contextTokens: number, type: KvCacheType = 'f16'): number {
  if (contextTokens <= 0) return 0
  const perLayerToken = 2 * attention.kvHeads * attention.headDim * BYTES_PER_ELEMENT[type]
  const sliding = Math.min(attention.layers, Math.max(0, attention.slidingLayers ?? 0))
  const global = attention.layers - sliding
  const window = attention.slidingWindow ? Math.min(contextTokens, attention.slidingWindow + SWA_BATCH_SLACK) : contextTokens
  return Math.round(perLayerToken * (global * contextTokens + sliding * window))
}

/**
 * Typical dense decoder shapes by size class, from real models, for when a model
 * card does not give the shape. Every row uses grouped-query attention, as nearly
 * every model released since 2023 does.
 */
const SIZE_CLASSES: Array<{ params: number } & Attention> = [
  { params: 0.5, layers: 24, kvHeads: 2, headDim: 64 }, // Qwen2.5 0.5B
  { params: 1, layers: 16, kvHeads: 8, headDim: 64 }, // Llama 3.2 1B
  { params: 1.5, layers: 28, kvHeads: 2, headDim: 128 }, // Qwen2.5 1.5B
  { params: 3, layers: 28, kvHeads: 8, headDim: 128 }, // Llama 3.2 3B
  { params: 4, layers: 36, kvHeads: 8, headDim: 128 }, // Qwen3 4B
  { params: 8, layers: 32, kvHeads: 8, headDim: 128 }, // Llama 3.1 8B, Mistral 7B
  { params: 12, layers: 40, kvHeads: 8, headDim: 128 }, // Mistral Nemo 12B
  { params: 14, layers: 48, kvHeads: 8, headDim: 128 }, // Qwen2.5 14B
  { params: 24, layers: 40, kvHeads: 8, headDim: 128 }, // Mistral Small 24B
  { params: 32, layers: 64, kvHeads: 8, headDim: 128 }, // Qwen2.5 / Qwen3 32B
  { params: 70, layers: 80, kvHeads: 8, headDim: 128 }, // Llama 3.1 70B
  { params: 123, layers: 88, kvHeads: 8, headDim: 128 }, // Mistral Large 2
  { params: 405, layers: 126, kvHeads: 8, headDim: 128 } // Llama 3.1 405B
]

/** The size class nearest (on a log scale) to `paramsBillions`. */
export function fallbackAttention(paramsBillions: number): Attention {
  const p = Number.isFinite(paramsBillions) && paramsBillions > 0 ? paramsBillions : 7
  let best = SIZE_CLASSES[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const row of SIZE_CLASSES) {
    const distance = Math.abs(Math.log(p / row.params))
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
    }
  }
  return { layers: best.layers, kvHeads: best.kvHeads, headDim: best.headDim }
}
