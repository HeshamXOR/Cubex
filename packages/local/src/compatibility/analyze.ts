import type { ModelInfo } from '../../../core/src/types/model'
import type { SystemProfile } from '../../../core/src/types/hardware'
import type { CompatibilityResult, CompatibilityStatus } from '../../../core/src/types/estimation'
import { estimateMemory } from '../estimation/memory'
import { estimateSpeed, bestGpu } from '../estimation/speed'

const GB = 1024 * 1024 * 1024

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

export type RecommendationGoal =
  | 'general'
  | 'coding'
  | 'reasoning'
  | 'fast'
  | 'long_context'
  | 'vision'
  | 'privacy'
  | 'low_memory'
  | 'quality'

export interface ScoredCompatibility extends CompatibilityResult {
  model: ModelInfo
}

/**
 * Produce a FACTUAL hardware-fit result for a model — never a subjective quality
 * score. Categories: fits_vram / offload_required / may_be_slow /
 * insufficient_memory / unsupported_runtime, each with a specific reason.
 */
export function analyzeCompatibility(
  model: ModelInfo,
  profile: SystemProfile,
  contextTokens: number,
  installedRuntimes?: string[]
): CompatibilityResult {
  const memory = estimateMemory(
    { parameterCount: model.parameterCount, quantization: model.quantization },
    contextTokens
  )
  const speed = estimateSpeed(
    { parameterCount: model.parameterCount, quantization: model.quantization },
    profile,
    memory,
    contextTokens
  )

  // Runtime availability check first.
  if (model.supportedRuntimes && installedRuntimes && installedRuntimes.length > 0) {
    const overlap = model.supportedRuntimes.some((r) => installedRuntimes.includes(r))
    if (!overlap) {
      return {
        status: 'unsupported_runtime',
        reason: `No installed runtime supports this model. It needs one of: ${model.supportedRuntimes.join(
          ', '
        )}; installed: ${installedRuntimes.join(', ') || 'none'}.`,
        memory,
        speed,
        gpuFraction: 0
      }
    }
  }

  const gpu = bestGpu(profile)
  const vram = gpu?.vramBytes ?? 0
  const ram = profile.memory.totalBytes
  const need = memory.totalBytes
  const gpuFraction = need.high > 0 ? Math.max(0, Math.min(1, vram / memory.weightsBytes.high)) : 0

  let status: CompatibilityStatus
  let reason: string

  if (need.high <= vram) {
    status = 'fits_vram'
    reason = `Model needs ~${gb(need.high)} and your GPU has ${gb(vram)} VRAM — it should fit fully on the GPU. Estimated ${speed.tokensPerSecond.low}–${speed.tokensPerSecond.high} tok/s.`
  } else if (need.high <= vram + ram) {
    if (vram === 0) {
      // CPU-only; decide slow vs workable by estimated speed.
      if (speed.tokensPerSecond.high < 5) {
        status = 'may_be_slow'
        reason = `Model needs ~${gb(need.high)} and will run on CPU/RAM only (no GPU VRAM detected). Estimated ${speed.tokensPerSecond.low}–${speed.tokensPerSecond.high} tok/s — likely slow.`
      } else {
        status = 'may_be_slow'
        reason = `Model needs ~${gb(need.high)}, fits in ${gb(ram)} RAM but runs on CPU only. Estimated ${speed.tokensPerSecond.low}–${speed.tokensPerSecond.high} tok/s.`
      }
    } else {
      status = 'offload_required'
      reason = `Model likely requires ~${gb(need.high)}, while your GPU has ${gb(vram)} VRAM (RAM: ${gb(ram)}). About ${Math.round(gpuFraction * 100)}% fits on GPU; the rest offloads to CPU/RAM, so expect ~${speed.tokensPerSecond.low}–${speed.tokensPerSecond.high} tok/s.`
    }
  } else if (need.low > vram + ram) {
    status = 'insufficient_memory'
    reason = `Model needs ~${gb(need.low)}–${gb(need.high)}, but you have ${gb(vram)} VRAM + ${gb(ram)} RAM = ${gb(vram + ram)} total. It will not fit.`
  } else {
    // Borderline: high estimate exceeds combined memory but low fits.
    status = 'may_be_slow'
    reason = `Model needs ~${gb(need.low)}–${gb(need.high)} vs ${gb(vram + ram)} total memory (${gb(vram)} VRAM + ${gb(ram)} RAM). It is borderline and may swap or run slowly.`
  }

  return { status, reason, memory, speed, gpuFraction }
}

const STATUS_RANK: Record<CompatibilityStatus, number> = {
  fits_vram: 0,
  offload_required: 1,
  may_be_slow: 2,
  insufficient_memory: 3,
  unsupported_runtime: 4
}

/**
 * Rank models by hardware fit for a given goal. This reorders by FACTUAL fit +
 * declared capabilities — it does not invent quality scores. `goal` gently
 * biases selection (e.g. low_memory prefers smaller models that fit best).
 */
export function recommendModels(
  models: ModelInfo[],
  profile: SystemProfile,
  goal: RecommendationGoal | string = 'general',
  installedRuntimes?: string[],
  contextTokens = 4096
): ScoredCompatibility[] {
  const scored: ScoredCompatibility[] = models
    .filter((m) => goalCapabilityFilter(m, goal))
    .map((model) => ({ model, ...analyzeCompatibility(model, profile, contextTokens, installedRuntimes) }))

  return scored.sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return goalTiebreak(a, b, goal)
  })
}

function goalCapabilityFilter(m: ModelInfo, goal: string): boolean {
  if (goal === 'vision') return m.capabilities.includes('vision') || m.capabilities.includes('image_input')
  if (goal === 'reasoning') return m.supportsReasoning || m.parameterCount === undefined || m.parameterCount >= 7
  return true
}

function goalTiebreak(a: ScoredCompatibility, b: ScoredCompatibility, goal: string): number {
  const pa = a.model.parameterCount ?? 0
  const pb = b.model.parameterCount ?? 0
  const speedA = a.speed.tokensPerSecond.high
  const speedB = b.speed.tokensPerSecond.high
  switch (goal) {
    case 'low_memory':
      return a.memory.totalBytes.high - b.memory.totalBytes.high // smaller first
    case 'quality':
      return pb - pa // larger params first (already filtered to fitting tiers by rank)
    case 'fast':
      return speedB - speedA
    case 'long_context':
      return (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
    case 'coding':
      return codingScore(b.model) - codingScore(a.model) || speedB - speedA
    default:
      return speedB - speedA
  }
}

function codingScore(m: ModelInfo): number {
  const name = `${m.displayName} ${m.family ?? ''}`.toLowerCase()
  return name.includes('coder') || name.includes('code') ? 1 : 0
}
