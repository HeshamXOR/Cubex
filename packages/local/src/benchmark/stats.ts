import type { BenchmarkStats } from '../../../core/src/types/benchmark'

/** Population statistics over a numeric sample. Safe for empty/singleton arrays. */
export function computeStats(values: number[]): BenchmarkStats {
  const n = values.length
  if (n === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, variance: 0, stddev: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const mid = Math.floor(n / 2)
  const median = n % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
  const min = sorted[0]!
  const max = sorted[n - 1]!
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  return { mean, median, min, max, variance, stddev }
}
