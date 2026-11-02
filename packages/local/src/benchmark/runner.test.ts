import { describe, expect, it } from 'vitest'
import { BenchmarkRunner } from './runner'
import { MockLocalRuntime } from '../runtimes/MockLocalRuntime'
import type { BenchmarkConfig } from '../../../core/src/types/benchmark'

const config: BenchmarkConfig = {
  modelId: 'mock-llama-8b',
  runtime: 'mock-local',
  prompt: 'Say hello.',
  maxOutputTokens: 64,
  runs: 3
}

describe('BenchmarkRunner', () => {
  it('runs the configured number of times and reports positive throughput', async () => {
    const runtime = new MockLocalRuntime()
    const provider = runtime.makeProvider(200, 'alpha beta gamma delta epsilon zeta eta theta')
    const runner = new BenchmarkRunner()
    const progress: number[] = []
    const result = await runner.run(config, {
      provider,
      onProgress: (p) => progress.push(p.run)
    })
    expect(result.runsData).toHaveLength(3)
    expect(result.tokensPerSecond.mean).toBeGreaterThan(0)
    expect(result.ttftMs.mean).toBeGreaterThanOrEqual(0)
    expect(progress).toEqual([1, 2, 3])
  })
})
