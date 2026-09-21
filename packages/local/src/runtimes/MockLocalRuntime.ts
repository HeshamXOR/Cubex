import { MockAIProvider } from '../../../core/src/providers/mock/MockAIProvider'
import type {
  LocalModelEntry,
  LocalRuntime,
  PullProgressUpdate,
  RuntimeDetection
} from './LocalRuntime'

export interface MockLocalOptions {
  installed?: boolean
  running?: boolean
  failStartup?: boolean
  insufficientMemory?: boolean
}

/**
 * A fully working local runtime that needs no real runtime installed. Simulates
 * detection, model listing, pulling (with synthetic progress), start/stop, and
 * can produce a token-generating provider for deterministic benchmark tests.
 */
export class MockLocalRuntime implements LocalRuntime {
  readonly id = 'mock-local'
  readonly name = 'Mock Local Runtime'
  private running: boolean

  constructor(private readonly opts: MockLocalOptions = {}) {
    this.running = opts.running ?? true
  }

  async detect(): Promise<RuntimeDetection> {
    return {
      installed: this.opts.installed ?? true,
      running: this.running,
      version: '0.0.0-mock',
      endpoint: 'mock://local'
    }
  }

  async listModels(): Promise<LocalModelEntry[]> {
    return [
      { id: 'mock-llama-8b', name: 'Mock Llama 8B', runtime: this.id, sizeBytes: 4_700_000_000, quantization: 'Q4_K_M', parameterCount: 8, family: 'llama' },
      { id: 'mock-qwen-3b', name: 'Mock Qwen 3B', runtime: this.id, sizeBytes: 2_000_000_000, quantization: 'Q4_K_M', parameterCount: 3, family: 'qwen2' }
    ]
  }

  async start(): Promise<void> {
    if (this.opts.failStartup) throw new Error('Mock runtime failed to start (simulated).')
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async pull(
    modelId: string,
    onProgress: (p: PullProgressUpdate) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.opts.insufficientMemory) {
      onProgress({ status: 'error', done: true, error: 'Insufficient memory to load model (simulated).' })
      return
    }
    const total = 2_000_000_000
    const steps = 5
    for (let i = 1; i <= steps; i++) {
      if (signal?.aborted) {
        onProgress({ status: 'cancelled', done: true })
        return
      }
      await delay(80, signal)
      const completed = Math.round((total * i) / steps)
      onProgress({
        status: i === steps ? 'verifying' : 'downloading',
        completedBytes: completed,
        totalBytes: total,
        speedBps: total / steps / 0.08,
        etaSeconds: ((steps - i) * 0.08),
        done: false
      })
    }
    onProgress({ status: 'success', done: true })
  }

  async deleteModel(_modelId: string): Promise<void> {
    // no-op for the mock
  }

  /**
   * Produce a MockAIProvider whose streaming cadence targets an approximate
   * tokens/second so BenchmarkRunner tests are deterministic.
   */
  makeProvider(tokensPerSecond = 40, reply?: string): MockAIProvider {
    const text = reply ?? Array.from({ length: 40 }, (_, i) => `token${i}`).join(' ')
    // chunkSize 1 word per chunk; delay per chunk to hit target tok/s.
    const chunkDelayMs = Math.max(0, Math.round(1000 / tokensPerSecond))
    return new MockAIProvider({ id: 'mock-local', reply: text, chunkSize: 1, chunkDelayMs })
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
