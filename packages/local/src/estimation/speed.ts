import type { GpuInfo, SystemProfile } from '../../../core/src/types/hardware'
import type { MemoryEstimate, Range, SpeedEstimate } from '../../../core/src/types/estimation'
import type { Quantization } from '../../../core/src/types/common'

const GB = 1024 * 1024 * 1024

/**
 * Memory-bandwidth heuristics (GB/s). Local LLM decode is overwhelmingly
 * bandwidth-bound: each generated token requires reading (roughly) the active
 * weights once, so tok/s ≈ bandwidth / bytes-read-per-token. These are ballpark
 * tiers by vendor/VRAM — NOT exact spec sheets — and only used for a *range*.
 */
function gpuBandwidthGBs(gpu: GpuInfo | undefined): number {
  if (!gpu) return 0
  const vramGb = (gpu.vramBytes ?? 0) / GB
  const model = gpu.model.toLowerCase()

  // Apple unified memory: bandwidth varies widely by chip tier.
  if (gpu.vendor === 'apple') {
    if (model.includes('ultra')) return 800
    if (model.includes('max')) return 400
    if (model.includes('pro')) return 200
    return 100
  }

  // Discrete GPUs: rough tiers by VRAM as a proxy for class.
  if (gpu.vendor === 'nvidia' || gpu.vendor === 'amd') {
    if (vramGb >= 24) return 900
    if (vramGb >= 16) return 700
    if (vramGb >= 12) return 500
    if (vramGb >= 8) return 400
    if (vramGb >= 6) return 300
    return 220
  }
  // Intel / integrated / unknown discrete.
  if (vramGb >= 8) return 250
  return 120
}

/** System RAM bandwidth guess (GB/s) for CPU inference when no GPU offload. */
function ramBandwidthGBs(profile: SystemProfile): number {
  if (profile.memory.bandwidthGBs) return profile.memory.bandwidthGBs
  return 50 // typical dual-channel DDR4/DDR5 desktop ballpark
}

function bestGpu(profile: SystemProfile): GpuInfo | undefined {
  const withVram = profile.gpus.filter((g) => (g.vramBytes ?? 0) > 0)
  if (!withVram.length) return profile.gpus[0]
  return withVram.reduce((a, b) => ((b.vramBytes ?? 0) > (a.vramBytes ?? 0) ? b : a))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function estimateSpeed(
  model: { parameterCount?: number; quantization?: Quantization },
  profile: SystemProfile,
  mem: MemoryEstimate,
  _contextTokens: number
): SpeedEstimate {
  const notes: string[] = []
  const gpu = bestGpu(profile)
  const vram = gpu?.vramBytes ?? 0
  const weightsHigh = mem.weightsBytes.high
  const weightsGb = weightsHigh / GB

  const gpuFraction = weightsHigh > 0 ? Math.max(0, Math.min(1, vram / weightsHigh)) : 0
  const paramsKnown = !!model.parameterCount
  const vramKnown = vram > 0

  let tps: Range
  let confidence: SpeedEstimate['confidence']

  if (gpuFraction >= 0.99 && vramKnown) {
    // Fully on GPU: bandwidth-bound.
    const bw = gpuBandwidthGBs(gpu)
    const mid = bw / Math.max(0.25, weightsGb)
    tps = { low: round1(mid * 0.65), high: round1(mid * 1.35), unit: 'tok/s' }
    confidence = paramsKnown ? 'high' : 'medium'
    notes.push(
      `Model fits in ${gpu?.model ?? 'GPU'} VRAM; estimate is bandwidth-bound using ~${bw} GB/s over ~${round1(
        weightsGb
      )} GB of weights.`
    )
  } else if (gpuFraction > 0) {
    // Split GPU/CPU: dominated by the slow (CPU/RAM) portion.
    const bw = gpuBandwidthGBs(gpu)
    const ramBw = ramBandwidthGBs(profile)
    // Effective bandwidth weighted by where the layers live.
    const effBw = bw * gpuFraction + ramBw * (1 - gpuFraction)
    const mid = effBw / Math.max(0.25, weightsGb)
    tps = { low: round1(mid * 0.4), high: round1(mid * 0.9), unit: 'tok/s' }
    confidence = 'low'
    notes.push(
      `~${Math.round(gpuFraction * 100)}% of the model fits in VRAM; the rest offloads to CPU/RAM (~${ramBw} GB/s), which dominates speed.`
    )
  } else {
    // Pure CPU.
    const ramBw = ramBandwidthGBs(profile)
    const mid = ramBw / Math.max(0.25, weightsGb)
    tps = { low: round1(mid * 0.35), high: round1(mid * 0.85), unit: 'tok/s' }
    confidence = 'low'
    notes.push(
      `No usable GPU VRAM detected; CPU-only inference bound by ~${ramBw} GB/s RAM bandwidth. Real speed depends heavily on core count and SIMD.`
    )
  }

  if (!paramsKnown) notes.push('Parameter count unknown — speed range widened.')

  // Time to first token: prefill of the prompt; short prompts are fast on GPU.
  const ttftLow = gpuFraction >= 0.99 ? 50 : 200
  const ttftHigh = gpuFraction >= 0.99 ? 400 : 2000
  const ttft: Range = { low: ttftLow, high: ttftHigh, unit: 'ms' }

  return { tokensPerSecond: tps, ttftMs: ttft, basis: 'theoretical', confidence, notes }
}

export { gpuBandwidthGBs, bestGpu }
