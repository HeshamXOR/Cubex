import { nanoid } from 'nanoid'
import { scanSystem } from '@local/hardware'
import { recommendModels } from '@local/compatibility'
import { BenchmarkRunner } from '@local/benchmark'
import { OllamaRuntime, MockLocalRuntime, type LocalRuntime } from '@local/runtimes'
import { CURATED_MODELS } from '@local/catalog'
import type {
  BenchmarkRequest,
  LocalModelEntry,
  ModelCompatibility,
  PullProgress,
  PullRequest,
  RuntimeStatus
} from '@shared/ipc'
import type { BenchmarkResult, SystemProfile } from '@core/types'
import { getSettings } from './config'
import { benchmarkRepo } from './db'
import { logger } from './logger'
import type { ProviderManager } from './ProviderManager'

/**
 * Local-model concerns: hardware scan, model recommendations, runtime detection,
 * model pulls, and benchmarking. Runtimes are modular (Ollama first; a mock is
 * available for testing without any runtime installed).
 */
export class LocalService {
  private profileCache: SystemProfile | null = null
  private readonly runtimes = new Map<string, LocalRuntime>()
  private readonly pulls = new Map<string, AbortController>()
  private readonly benches = new Map<string, AbortController>()

  constructor(
    private readonly providers: ProviderManager,
    private readonly onPullProgress: (p: PullProgress & { pullId: string }) => void,
    private readonly onBenchProgress: (p: {
      benchId: string
      done: boolean
      result?: BenchmarkResult
      progress?: number
    }) => void
  ) {
    const s = getSettings()
    this.runtimes.set('ollama', new OllamaRuntime(s.local.ollamaBaseUrl))
    if (process.env.CUBEX_MOCK_LOCAL === '1') {
      this.runtimes.set('mock-local', new MockLocalRuntime({ installed: true, running: true }))
    }
  }

  async scanHardware(force = false): Promise<SystemProfile> {
    if (this.profileCache && !force) return this.profileCache
    const modelsDir = getSettings().local.modelsDir
    this.profileCache = await scanSystem(modelsDir ? { modelsDir } : {})
    logger.info('Hardware scan complete', { status: 'ok' })
    return this.profileCache
  }

  async listRuntimes(): Promise<RuntimeStatus[]> {
    const out: RuntimeStatus[] = []
    for (const [id, rt] of this.runtimes) {
      const det = await rt
        .detect()
        .catch((e: unknown) => ({ installed: false, running: false, error: String(e) }))
      out.push({ id, name: rt.name, ...det })
    }
    return out
  }

  private async installedRuntimeIds(): Promise<string[]> {
    const statuses = await this.listRuntimes()
    return statuses.filter((s) => s.running).map((s) => s.id)
  }

  async analyzeModels(goal = 'general'): Promise<ModelCompatibility[]> {
    const profile = await this.scanHardware()
    const installed = await this.installedRuntimeIds()
    const ctx = getSettings().local.contextSize
    const results = recommendModels(CURATED_MODELS, profile, goal, installed, ctx)
    return results as ModelCompatibility[]
  }

  async listLocalModels(): Promise<LocalModelEntry[]> {
    const out: LocalModelEntry[] = []
    for (const [, rt] of this.runtimes) {
      try {
        out.push(...(await rt.listModels()))
      } catch {
        // runtime not reachable; skip
      }
    }
    return out
  }

  async browseModels(query?: string): Promise<typeof CURATED_MODELS> {
    if (!query) return CURATED_MODELS
    const q = query.toLowerCase()
    return CURATED_MODELS.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.family ?? '').toLowerCase().includes(q)
    )
  }

  async pull(req: PullRequest): Promise<{ pullId: string }> {
    const rt = this.runtimes.get(req.runtime)
    const pullId = nanoid()
    if (!rt?.pull) {
      this.onPullProgress({ pullId, modelId: req.modelId, status: 'error', done: true, error: 'Runtime does not support pulling.' })
      return { pullId }
    }
    const controller = new AbortController()
    this.pulls.set(pullId, controller)
    void rt
      .pull(
        req.modelId,
        (p) =>
          this.onPullProgress({
            pullId,
            modelId: req.modelId,
            status: p.status,
            ...(p.completedBytes !== undefined ? { completedBytes: p.completedBytes } : {}),
            ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}),
            ...(p.speedBps !== undefined ? { speedBps: p.speedBps } : {}),
            ...(p.etaSeconds !== undefined ? { etaSeconds: p.etaSeconds } : {}),
            done: p.done,
            ...(p.error ? { error: p.error } : {})
          }),
        controller.signal
      )
      .catch((err: unknown) =>
        this.onPullProgress({ pullId, modelId: req.modelId, status: 'error', done: true, error: String(err) })
      )
      .finally(() => this.pulls.delete(pullId))
    return { pullId }
  }

  cancelPull(pullId: string): void {
    this.pulls.get(pullId)?.abort()
    this.pulls.delete(pullId)
  }

  async deleteLocalModel(runtime: string, modelId: string): Promise<void> {
    await this.runtimes.get(runtime)?.deleteModel?.(modelId)
  }

  async runBenchmark(req: BenchmarkRequest): Promise<{ benchId: string }> {
    const benchId = nanoid()
    const controller = new AbortController()
    this.benches.set(benchId, controller)
    const provider = this.providers.resolve(this.providerForRuntime(req.config.runtime))
    if (!provider) {
      this.onBenchProgress({ benchId, done: true })
      return { benchId }
    }
    const runner = new BenchmarkRunner()
    void runner
      .run(req.config, {
        provider,
        signal: controller.signal,
        onProgress: (p) => this.onBenchProgress({ benchId, done: false, progress: p.run / p.total })
      })
      .then((result) => {
        benchmarkRepo.save(result.id, req.config.modelId, result)
        this.onBenchProgress({ benchId, done: true, result })
        logger.info('Benchmark complete', { model: req.config.modelId, status: 'ok' })
      })
      .catch((err: unknown) => {
        logger.error(`Benchmark failed: ${String(err)}`, { model: req.config.modelId })
        this.onBenchProgress({ benchId, done: true })
      })
      .finally(() => this.benches.delete(benchId))
    return { benchId }
  }

  cancelBenchmark(benchId: string): void {
    this.benches.get(benchId)?.abort()
    this.benches.delete(benchId)
  }

  listBenchmarks(modelId?: string): BenchmarkResult[] {
    return benchmarkRepo.list(modelId) as BenchmarkResult[]
  }

  /** Map a runtime id to a configured provider id that can generate tokens. */
  private providerForRuntime(runtime: string): string {
    return runtime === 'mock-local' ? 'mock-local' : 'ollama'
  }
}
