import type { Quantization } from '../../../core/src/types/common'
import type { MemoryEstimate, Range } from '../../../core/src/types/estimation'

const GB = 1024 * 1024 * 1024

/**
 * Effective bytes-per-parameter for common formats. GGUF k-quants carry metadata
 * + partial higher-precision tensors, so these are *effective averages* over a
 * whole model, not the nominal bit-width. Unknown formats assume ~4-bit.
 */
export function bytesPerParam(quant: Quantization | undefined): number {
  switch (quant) {
    case 'FP32':
      return 4
    case 'FP16':
    case 'BF16':
      return 2
    case 'INT8':
    case 'Q8_0':
      return 1
    case 'Q6_K':
      return 0.82
    case 'Q5_K_M':
    case 'Q5_K_S':
      return 0.7
    case 'Q4_K_M':
    case 'Q4_K_S':
    case 'Q4_0':
    case 'INT4':
    case 'AWQ':
    case 'GPTQ':
      return 0.55
    case 'Q3_K_M':
      return 0.43
    case 'Q2_K':
      return 0.33
    default:
      return 0.7 // unknown: assume a ~5-bit-ish average, noted by callers
  }
}

function range(low: number, high: number, unit = 'bytes'): Range {
  return { low: Math.round(low), high: Math.round(high), unit }
}

export function estimateWeightsBytes(paramsBillions: number, quant: Quantization | undefined): Range {
  const mid = paramsBillions * 1e9 * bytesPerParam(quant)
  return range(mid * 0.92, mid * 1.08)
}

/** Rough architecture shape from parameter count when the model card is silent. */
function archShape(paramsBillions: number): { layers: number; hidden: number } {
  const table: Array<{ p: number; layers: number; hidden: number }> = [
    { p: 1, layers: 22, hidden: 2048 },
    { p: 3, layers: 26, hidden: 3072 },
    { p: 7, layers: 32, hidden: 4096 },
    { p: 8, layers: 32, hidden: 4096 },
    { p: 13, layers: 40, hidden: 5120 },
    { p: 14, layers: 40, hidden: 5120 },
    { p: 34, layers: 48, hidden: 7168 },
    { p: 70, layers: 80, hidden: 8192 }
  ]
  let best = table[0]!
  for (const row of table) {
    if (Math.abs(row.p - paramsBillions) < Math.abs(best.p - paramsBillions)) best = row
  }
  return { layers: best.layers, hidden: best.hidden }
}

/**
 * KV cache ≈ contextTokens * 2 (K and V) * layers * hidden * 2 bytes (fp16).
 * This assumes an fp16 cache and no GQA reduction, so it's an upper-ish bound;
 * we widen the range downward to reflect GQA models using far less.
 */
export function estimateKvCacheBytes(
  contextTokens: number,
  paramsBillions: number,
  hiddenSize?: number,
  numLayers?: number
): Range {
  const shape = archShape(paramsBillions)
  const layers = numLayers ?? shape.layers
  const hidden = hiddenSize ?? shape.hidden
  const full = contextTokens * 2 * layers * hidden * 2
  // Low end reflects GQA (~1/4 to 1/8 the KV heads); high end the full estimate.
  return range(full * 0.2, full)
}

export function estimateOverheadBytes(weightsHigh: number): Range {
  const fixed = 0.5 * GB
  return range(fixed + weightsHigh * 0.1, fixed + weightsHigh * 0.2)
}

export function estimateMemory(
  model: { parameterCount?: number; quantization?: Quantization },
  contextTokens: number
): MemoryEstimate {
  const notes: string[] = []
  const params = model.parameterCount ?? 0

  if (!params) {
    notes.push('Parameter count unknown — memory estimate is very rough.')
  }
  const bpp = bytesPerParam(model.quantization)
  notes.push(
    `Assumed ~${bpp.toFixed(2)} bytes/param for quantization "${model.quantization ?? 'unknown'}" (effective average).`
  )
  notes.push(`Context size assumed ${contextTokens} tokens for KV cache.`)
  notes.push('GGUF k-quant overhead and GQA are approximated; treat as a range.')

  const weights = estimateWeightsBytes(params, model.quantization)
  const kv = estimateKvCacheBytes(contextTokens, params || 7)
  const overhead = estimateOverheadBytes(weights.high)
  const total: Range = {
    low: weights.low + kv.low + overhead.low,
    high: weights.high + kv.high + overhead.high,
    unit: 'bytes'
  }

  return {
    totalBytes: total,
    weightsBytes: weights,
    kvCacheBytes: kv,
    overheadBytes: overhead,
    basis: 'theoretical',
    notes
  }
}
