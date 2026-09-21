/**
 * Performance/memory estimation types. Every number carries a `confidence` and a
 * `basis` label so the UI never presents a guess as a measured fact.
 */

export type EstimateBasis = 'theoretical' | 'runtime' | 'measured'

/** A value with an uncertainty range. When low===high it's effectively exact. */
export interface Range {
  low: number
  high: number
  unit: string
}

export interface MemoryEstimate {
  /** Approximate weights + KV cache + overhead, in bytes. */
  totalBytes: Range
  weightsBytes: Range
  kvCacheBytes: Range
  overheadBytes: Range
  basis: EstimateBasis
  /** Human-readable notes about assumptions. */
  notes: string[]
}

export interface SpeedEstimate {
  /** Generation throughput. */
  tokensPerSecond: Range
  /** Time to first token, ms. */
  ttftMs?: Range
  basis: EstimateBasis
  confidence: 'low' | 'medium' | 'high'
  notes: string[]
}

/** Factual (non-subjective) hardware-fit categories. */
export type CompatibilityStatus =
  | 'fits_vram' // ✅ fits in VRAM
  | 'offload_required' // ⚠ needs CPU/RAM offload
  | 'may_be_slow' // ⚠ fits but likely slow
  | 'insufficient_memory' // ❌ not enough memory
  | 'unsupported_runtime' // ❌ no compatible runtime

export interface CompatibilityResult {
  status: CompatibilityStatus
  /** Specific, factual reason string shown to the user. */
  reason: string
  memory: MemoryEstimate
  speed: SpeedEstimate
  /** Fraction of the model that fits on GPU (0..1). */
  gpuFraction: number
}
