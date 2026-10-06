import { nanoid } from 'nanoid'
import { scanSystem } from '@local/hardware'
import { recommendModels } from '@local/compatibility'
import { BenchmarkRunner } from '@local/benchmark'
import { PullManager, runGuardedPull, type PullEvent } from '@local/download'
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
import { isModelName, MODEL_NAME_HINT } from '@shared/modelName'
import type { BenchmarkResult, SystemProfile } from '@core/types'
import { getSettings } from './config'
import { benchmarkRepo } from './db'
import { logger } from './logger'
import type { ProviderManager } from './ProviderManager'

export interface LocalServiceOptions {
  /** Replaces the runtimes built from settings, for tests. */
  runtimes?: LocalRuntime[]
  /** Free bytes on the volume holding a folder, for tests. Defaults to the real disk. */
  freeBytes?: (dir: string) => Promise<number>
  /** How long a download may receive no bytes before it is reported as stalled. */
  stallAfterMs?: number
}

/** The approximate size of a curated model, for the disk check when a runtime cannot size it. */
function catalogBytes(modelId: string): number | undefined {
  return CURATED_MODELS.find((m) => m.id === modelId)?.downloadSizeBytes
}

/** A renderer-supplied download request is untrusted: it names a known runtime and a model name, nothing else. */
function parsePullRequest(req: unknown, runtimes: ReadonlyMap<string, LocalRuntime>): PullRequest {
  if (typeof req !== 'object' || req === null) throw new Error('Invalid download request.')
  const { runtime, modelId } = req as Record<string, unknown>
  if (typeof runtime !== 'string' || !runtimes.has(runtime)) throw new Error(`Unknown runtime "${String(runtime).slice(0, 40)}".`)
  const name = typeof modelId === 'string' ? modelId.trim() : ''
  if (!isModelName(name)) throw new Error(MODEL_NAME_HINT)
  return { runtime, modelId: name }
}

/**
 * Local-model concerns: hardware scan, model recommendations, runtime detection,
 * model pulls, and benchmarking. Runtimes are modular (Ollama first; a mock is
 * available for testing without any runtime installed).
 */
export class LocalService {
  private profileCache: SystemProfile | null = null
  private readonly runtimes = new Map<string, LocalRuntime>()
  /** One line of downloads per runtime: a runtime fetches one model at a time, the rest wait their turn. */
  private readonly lanes = new Map<string, PullManager>()
  private readonly pullIdByModel = new Map<string, string>()
  private readonly pullOwner = new Map<string, { runtime: string; key: string }>()
  private readonly benches = new Map<string, AbortController>()

  constructor(
    private readonly providers: ProviderManager,
    private readonly onPullProgress: (p: PullProgress & { pullId: string }) => void,
    private readonly onBenchProgress: (p: {
      benchId: string
      done: boolean
      result?: BenchmarkResult
      progress?: number
    }) => void,
    private readonly options: LocalServiceOptions = {}
  ) {
    if (options.runtimes) {
      for (const rt of options.runtimes) this.runtimes.set(rt.id, rt)
    } else {
      this.runtimes.set('ollama', new OllamaRuntime(getSettings().local.ollamaBaseUrl))
      if (process.env.CUBEX_MOCK_LOCAL === '1') {
        this.runtimes.set('mock-local', new MockLocalRuntime({ installed: true, running: true }))
      }
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

  /**
   * Start, or queue, a model download. The renderer hears about it through the
   * progress events: a runtime fetches one model at a time, so a second request waits
   * ("queued, 2nd") and starts when the first finishes. Asking for a model that is
   * already downloading or waiting returns that download instead of adding another.
   */
  async pull(req: unknown): Promise<{ pullId: string }> {
    const { runtime, modelId } = parsePullRequest(req, this.runtimes)
    const key = `${runtime}\n${modelId}`
    const current = this.pullIdByModel.get(key)
    if (current) return { pullId: current }

    const rt = this.runtimes.get(runtime)!
    const pullId = nanoid()
    this.pullIdByModel.set(key, pullId)
    this.pullOwner.set(pullId, { runtime, key })
    this.lane(runtime).enqueue({
      pullId,
      modelId,
      run: (onProgress, signal) =>
        runGuardedPull(
          { runtime: rt, modelId, catalogBytes, ...(this.options.freeBytes ? { freeBytes: this.options.freeBytes } : {}) },
          onProgress,
          signal
        )
    })
    return { pullId }
  }

  cancelPull(pullId: string): void {
    const owner = typeof pullId === 'string' ? this.pullOwner.get(pullId) : undefined
    if (owner) this.lanes.get(owner.runtime)?.cancel(pullId)
  }

  private lane(runtime: string): PullManager {
    const existing = this.lanes.get(runtime)
    if (existing) return existing
    const lane = new PullManager({
      maxConcurrent: 1,
      ...(this.options.stallAfterMs !== undefined ? { stallAfterMs: this.options.stallAfterMs } : {}),
      onEvent: (event) => this.forwardPull(runtime, event)
    })
    this.lanes.set(runtime, lane)
    return lane
  }

  private forwardPull(runtime: string, event: PullEvent): void {
    if (event.done) {
      const owner = this.pullOwner.get(event.pullId)
      if (owner) this.pullIdByModel.delete(owner.key)
      this.pullOwner.delete(event.pullId)
    }
    this.onPullProgress({ ...event, runtime })
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
