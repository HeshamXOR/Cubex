import { nanoid } from 'nanoid'
import type { AIProvider } from '../../../core/src/types/provider'
import type { AIRequest } from '../../../core/src/types/request'
import type { BenchmarkConfig, BenchmarkResult, BenchmarkRun } from '../../../core/src/types/benchmark'
import { userMessage } from '../../../core/src/builders'
import { computeStats } from './stats'

export interface BenchmarkDeps {
  provider: AIProvider
  signal?: AbortSignal
  onProgress?: (p: { run: number; total: number }) => void
  hardwareSummary?: string
}

/**
 * Runs a controlled generation benchmark against any AIProvider and produces
 * MEASURED throughput/TTFT statistics (basis: 'measured' — these are real
 * measurements, not estimates). Each run streams the same prompt; the config is
 * stored with the result so runs at different settings are never conflated.
 */
export class BenchmarkRunner {
  async run(config: BenchmarkConfig, deps: BenchmarkDeps): Promise<BenchmarkResult> {
    const startedAt = Date.now()
    const runsData: BenchmarkRun[] = []

    for (let i = 0; i < config.runs; i++) {
      if (deps.signal?.aborted) break
      deps.onProgress?.({ run: i + 1, total: config.runs })
      const run = await this.singleRun(i, config, deps)
      if (run) runsData.push(run)
    }

    const tps = computeStats(runsData.map((r) => r.tokensPerSecond))
    const ttft = computeStats(runsData.map((r) => r.ttftMs))
    const peakVram = maxDefined(runsData.map((r) => r.peakVramBytes))
    const peakRam = maxDefined(runsData.map((r) => r.peakRamBytes))

    return {
      id: nanoid(),
      config,
      runsData,
      tokensPerSecond: tps,
      ttftMs: ttft,
      ...(peakVram !== undefined ? { peakVramBytes: peakVram } : {}),
      ...(peakRam !== undefined ? { peakRamBytes: peakRam } : {}),
      startedAt,
      completedAt: Date.now(),
      ...(deps.hardwareSummary ? { hardwareSummary: deps.hardwareSummary } : {})
    }
  }

  private async singleRun(
    index: number,
    config: BenchmarkConfig,
    deps: BenchmarkDeps
  ): Promise<BenchmarkRun | null> {
    const request: AIRequest = {
      model: config.modelId,
      messages: [userMessage(config.prompt)],
      params: {
        maxOutputTokens: config.maxOutputTokens,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {})
      },
      stream: true
    }

    const startedAt = Date.now()
    let firstTokenAt: number | undefined
    let text = ''
    let usageOut: number | undefined
    let usageIn: number | undefined

    try {
      for await (const ev of deps.provider.streamMessage(request, deps.signal ? { signal: deps.signal } : {})) {
        if (ev.type === 'text_delta') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          text += ev.text
        } else if (ev.type === 'usage') {
          usageOut = ev.usage.outputTokens ?? usageOut
          usageIn = ev.usage.inputTokens ?? usageIn
        } else if (ev.type === 'completed') {
          usageOut = ev.response.usage?.outputTokens ?? usageOut
          usageIn = ev.response.usage?.inputTokens ?? usageIn
        } else if (ev.type === 'error') {
          throw ev.error
        }
      }
    } catch (err) {
      if (deps.signal?.aborted) return null
      throw err
    }

    const completedAt = Date.now()
    const ttftMs = (firstTokenAt ?? completedAt) - startedAt
    const generationMs = Math.max(1, completedAt - (firstTokenAt ?? completedAt))
    const generatedTokens = usageOut ?? approxTokens(text)
    const totalMs = completedAt - startedAt
    const tokensPerSecond = generatedTokens / (generationMs / 1000)

    return {
      index,
      ...(usageIn !== undefined ? { promptTokens: usageIn } : {}),
      generatedTokens,
      ttftMs,
      generationMs,
      totalMs,
      tokensPerSecond: round2(tokensPerSecond)
    }
  }
}

function approxTokens(text: string): number {
  // Whitespace-ish token approximation when the runtime doesn't report usage.
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words * 1.3))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined)
  return defined.length ? Math.max(...defined) : undefined
}
