import type { MemoryEstimate, Range } from '../../../core/src/types/estimation'
import { fallbackAttention, kvCacheBytes, type Attention, type KvCacheType } from './attention'
import { bitsPerWeight, isKnownQuant, normalizeQuant } from './quant'

const GIB = 1024 * 1024 * 1024

/** Effective bytes per parameter: bits per weight (see quant.ts) over eight. */
export function bytesPerParam(quant: string | undefined): number {
  return bitsPerWeight(quant) / 8
}

function range(low: number, high: number, unit = 'bytes'): Range {
  return { low: Math.round(low), high: Math.round(high), unit }
}

function positive(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Weights from parameters times effective bits. Published GGUF sizes sit within
 * about 1.5 percent of this for the common quantizations, so the band is 3
 * percent for a known quantization and wider when the quantization is a guess.
 */
export function estimateWeightsBytes(paramsBillions: number, quant: string | undefined): Range {
  const mid = positive(paramsBillions) * 1e9 * bytesPerParam(quant)
  const spread = isKnownQuant(quant) ? 0.03 : 0.15
  return range(mid * (1 - spread), mid * (1 + spread))
}

/** How far a size-class attention guess may be off the real cache, as multipliers of the guess. */
const GUESS_LOW = 0.85
const GUESS_HIGH = 1.25

export interface KvCacheOptions {
  /** The model's real attention shape; without it a size-class guess widens the range. */
  attention?: Attention
  kvCacheType?: KvCacheType
}

/**
 * Key and value cache for a context. Exact when the attention shape is known;
 * otherwise taken from the nearest size class (see attention.ts) and widened.
 * Hidden size is not an input: under grouped-query attention it does not
 * determine the cache width, the number of KV heads does.
 */
export function estimateKvCacheBytes(
  contextTokens: number,
  paramsBillions: number,
  options: KvCacheOptions = {}
): Range {
  const type = options.kvCacheType ?? 'f16'
  if (options.attention) {
    const exact = kvCacheBytes(options.attention, contextTokens, type)
    return range(exact, exact)
  }
  const guess = kvCacheBytes(fallbackAttention(paramsBillions), contextTokens, type)
  return range(guess * GUESS_LOW, guess * GUESS_HIGH)
}

/**
 * Runtime cost beyond weights and cache: the CUDA or Metal context and the
 * compute buffers, which grow with the model's width. About 0.5 to 1 GiB for an
 * 8B model, 1.2 to 3 GiB for a 70B one.
 */
export function estimateOverheadBytes(weightsHigh: number): Range {
  const w = positive(weightsHigh)
  return range(0.4 * GIB + w * 0.02, 0.7 * GIB + w * 0.06)
}

/** What the memory estimate needs to know about a model. */
export interface MemoryModelInput {
  /** Billions of parameters (all of them, also for mixture-of-experts models). */
  parameterCount?: number
  quantization?: string
  /** Size of the weights file when known; beats parameters times bits. */
  diskSizeBytes?: number
  attention?: Attention
}

export interface MemoryOptions {
  kvCacheType?: KvCacheType
}

export function estimateMemory(
  model: MemoryModelInput,
  contextTokens: number,
  options: MemoryOptions = {}
): MemoryEstimate {
  const notes: string[] = []
  const tokens = Math.max(0, Math.floor(positive(contextTokens)))
  const kvType = options.kvCacheType ?? 'f16'
  const quant = normalizeQuant(model.quantization)
  const disk = positive(model.diskSizeBytes)
  let params = positive(model.parameterCount)

  let weights: Range
  if (disk) {
    // The file is the tensor data plus a few MB of metadata and tokenizer.
    weights = range(disk * 0.99, disk * 1.01)
    if (!params) params = (disk * 8) / bitsPerWeight(quant) / 1e9
    notes.push('Weights taken from the file size on disk.')
  } else if (params) {
    weights = estimateWeightsBytes(params, quant)
    notes.push(
      isKnownQuant(quant)
        ? `Weights estimated at about ${bitsPerWeight(quant).toFixed(2)} bits per weight for ${quant}.`
        : `Quantization unknown, so about ${bitsPerWeight(quant).toFixed(1)} bits per weight were assumed.`
    )
  } else {
    weights = range(0, 0)
    notes.push('Parameter count unknown, so the weights are not counted and the estimate is very rough.')
  }

  const kv = estimateKvCacheBytes(tokens, params, { attention: model.attention, kvCacheType: kvType })
  if (model.attention) {
    notes.push(
      `KV cache is exact for ${model.attention.layers} layers and ${model.attention.kvHeads} KV heads at ${tokens} tokens (${kvType}).`
    )
  } else {
    notes.push(
      `KV cache uses a guess from the nearest model size class at ${tokens} tokens (${kvType}), so it is a range.`
    )
  }
  if (kvType !== 'f16') notes.push('A quantized KV cache needs flash attention in llama.cpp.')

  const overhead = estimateOverheadBytes(weights.high)
  notes.push('Runtime overhead (GPU context and compute buffers) is an allowance, not a measurement.')

  return {
    totalBytes: {
      low: weights.low + kv.low + overhead.low,
      high: weights.high + kv.high + overhead.high,
      unit: 'bytes'
    },
    weightsBytes: weights,
    kvCacheBytes: kv,
    overheadBytes: overhead,
    basis: 'theoretical',
    notes
  }
}
