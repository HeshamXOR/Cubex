/**
 * Benchmark results replace estimates with measured values. The config is stored
 * alongside results so runs at different settings are never compared as equal.
 */

export interface BenchmarkConfig {
  modelId: string
  runtime: string
  prompt: string
  maxOutputTokens: number
  /** Number of generation runs to average. */
  runs: number
  contextTokens?: number
  temperature?: number
}

export interface BenchmarkRun {
  index: number
  promptTokens?: number
  generatedTokens: number
  ttftMs: number
  generationMs: number
  totalMs: number
  tokensPerSecond: number
  promptProcessingTps?: number
  peakVramBytes?: number
  peakRamBytes?: number
}

export interface BenchmarkStats {
  mean: number
  median: number
  min: number
  max: number
  variance: number
  stddev: number
}

export interface BenchmarkResult {
  id: string
  config: BenchmarkConfig
  runsData: BenchmarkRun[]
  tokensPerSecond: BenchmarkStats
  ttftMs: BenchmarkStats
  peakVramBytes?: number
  peakRamBytes?: number
  startedAt: number
  completedAt: number
  hardwareSummary?: string
}
