import { SpeedMeter } from '../download/speedMeter'
import type {
  LocalModelEntry,
  LocalRuntime,
  PullErrorCode,
  PullEstimate,
  PullPhase,
  PullProgressUpdate,
  RuntimeDetection
} from './LocalRuntime'
import { blobBytesOnDisk, fetchOllamaManifest, ollamaModelsDir, parseOllamaModelRef } from './ollamaRegistry'

/** How Ollama and the operating systems word a full disk. */
const DISK_FULL = /no space left|not enough space|disk (?:is )?full|ENOSPC/i
const DISK_ADVICE = "Free up space, or move Ollama's models to a larger drive with the OLLAMA_MODELS setting."

interface OllamaTagsResponse {
  models?: Array<{
    name: string
    size?: number
    details?: {
      family?: string
      parameter_size?: string
      quantization_level?: string
    }
    modified_at?: string
  }>
}

interface OllamaPullLine {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

/** "7B" -> 7, "3.2B" -> 3.2, "137M" -> 0.137 (billions of parameters). */
function parseParameterSize(text: string | undefined): number | undefined {
  const m = /^\s*([\d.]+)\s*([KMBT]?)/i.exec(text ?? '')
  if (!m) return undefined
  const n = parseFloat(m[1]!)
  if (Number.isNaN(n)) return undefined
  switch (m[2]!.toUpperCase()) {
    case 'K':
      return n / 1_000_000
    case 'M':
      return n / 1000
    case 'T':
      return n * 1000
    default:
      return n
  }
}

/** Ollama's status lines are terse and full of layer digests; map them to something a person can read. */
function describeStatus(status: string): { status: string; phase: PullPhase } {
  const s = status.toLowerCase()
  if (s === 'success') return { status: 'success', phase: 'done' }
  if (s.startsWith('pulling manifest')) return { status: 'pulling manifest', phase: 'preparing' }
  if (s.startsWith('verifying')) return { status: 'verifying', phase: 'verifying' }
  if (s.startsWith('writing manifest') || s.startsWith('removing')) return { status, phase: 'finalizing' }
  return { status: 'downloading', phase: 'downloading' }
}

export interface OllamaRuntimeOptions {
  /** Where Ollama keeps its models on this PC. Defaults to OLLAMA_MODELS, then `.ollama/models` in the home folder. */
  modelsDir?: string
  /** Used for the registry lookup that sizes a download. Defaults to the global fetch. */
  registryFetch?: typeof fetch
}

/** A server on this PC keeps its models on this PC's disks; a remote one does not. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/**
 * Ollama runtime adapter. Talks to the local Ollama HTTP server. Because the
 * server is only reachable when running, we treat "reachable" as running; we
 * cannot distinguish "installed but stopped" over HTTP alone.
 */
export class OllamaRuntime implements LocalRuntime {
  readonly id = 'ollama'
  readonly name = 'Ollama'
  readonly diskAdvice = DISK_ADVICE

  constructor(
    private readonly baseUrl: string = 'http://127.0.0.1:11434',
    private readonly options: OllamaRuntimeOptions = {}
  ) {}

  private url(path: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl
    return `${base}${path}`
  }

  async detect(): Promise<RuntimeDetection> {
    try {
      // A host that never answers must not hold up the screen that asked.
      const res = await fetch(this.url('/api/version'), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) {
        return { installed: true, running: false, endpoint: this.baseUrl, error: `HTTP ${res.status}` }
      }
      const data = (await res.json()) as { version?: string }
      return { installed: true, running: true, endpoint: this.baseUrl, ...(data.version ? { version: data.version } : {}) }
    } catch {
      return {
        installed: false,
        running: false,
        endpoint: this.baseUrl,
        error: `Ollama not reachable at ${this.baseUrl}`
      }
    }
  }

  async listModels(): Promise<LocalModelEntry[]> {
    const res = await fetch(this.url('/api/tags'))
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`)
    const data = (await res.json()) as OllamaTagsResponse
    return (data.models ?? []).map((m) => {
      const parameterCount = parseParameterSize(m.details?.parameter_size)
      return {
        id: m.name,
        name: m.name,
        runtime: this.id,
        ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
        ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(m.details?.family ? { family: m.details.family } : {}),
        ...(m.modified_at ? { lastUsed: Date.parse(m.modified_at) || undefined } : {})
      }
    })
  }

  /**
   * Stream `/api/pull`. Progress is summed over every layer seen so far (Ollama
   * reports one layer at a time), speed and ETA come from a sliding window, and
   * the stream ending early is an error rather than a silent success. Aborting
   * the signal cancels the HTTP request and the reader; Ollama keeps the layers
   * it already has, so a later pull resumes where this one stopped.
   */
  async pull(
    modelId: string,
    onProgress: (p: PullProgressUpdate) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const cancelled = (): void => onProgress({ status: 'cancelled', phase: 'cancelled', done: true })
    const failed = (error: string, errorCode: PullErrorCode = 'failed'): void =>
      onProgress({ status: 'error', phase: 'error', errorCode, done: true, error })
    if (signal?.aborted) return cancelled()

    let res: Response
    try {
      res = await fetch(this.url('/api/pull'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: modelId, stream: true }),
        ...(signal ? { signal } : {})
      })
    } catch (err) {
      if (signal?.aborted) return cancelled()
      return failed(
        `Could not reach Ollama at ${this.baseUrl}. Make sure Ollama is running, then try again.${reasonSuffix(err)}`,
        'runtime_unreachable'
      )
    }
    if (!res.ok || !res.body) {
      return failed(`Ollama /api/pull returned ${res.status}${await readErrorDetail(res)}`)
    }

    const reader = res.body.getReader()
    const onAbort = (): void => {
      // Some fetch implementations leave the body open after an abort; cancelling the
      // reader ends a pending read either way and releases the connection.
      void reader.cancel().catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const decoder = new TextDecoder()
    const layers = new Map<string, { total: number; completed: number }>()
    const meter = new SpeedMeter()
    let buffer = ''
    let sawSuccess = false

    const totals = (): { completed: number; total: number } => {
      let completed = 0
      let total = 0
      for (const l of layers.values()) {
        completed += l.completed
        total += l.total
      }
      return { completed, total }
    }

    const handle = (line: OllamaPullLine): boolean => {
      if (line.error) {
        if (DISK_FULL.test(line.error)) {
          failed(
            `The disk is full, so Ollama could not write the model. ${DISK_ADVICE} Then try again; layers already downloaded are kept.`,
            'disk_space'
          )
        } else {
          failed(line.error)
        }
        return true
      }
      const described = describeStatus(line.status ?? 'pulling')
      if (line.total !== undefined) {
        const key = line.digest ?? '_'
        const previous = layers.get(key)
        layers.set(key, {
          total: line.total,
          completed: Math.max(previous?.completed ?? 0, line.completed ?? previous?.completed ?? 0)
        })
      }
      const { completed, total } = totals()
      if (described.phase === 'done') {
        sawSuccess = true
        return false
      }
      if (described.phase === 'downloading' && total > 0) meter.add(completed)
      const speedBps = described.phase === 'downloading' ? meter.bytesPerSecond() : undefined
      const etaSeconds = speedBps ? meter.etaSeconds(total - completed) : undefined
      onProgress({
        status: described.status,
        phase: described.phase,
        ...(total > 0 ? { completedBytes: completed, totalBytes: total } : {}),
        ...(speedBps !== undefined ? { speedBps } : {}),
        ...(etaSeconds !== undefined ? { etaSeconds } : {}),
        done: false
      })
      return false
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const text = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!text) continue
          const parsed = safeParse(text)
          if (!parsed) continue
          if (handle(parsed)) return
        }
      }
    } catch (err) {
      if (signal?.aborted) return cancelled()
      return failed(
        `The connection to Ollama was lost. Check that Ollama is still running, then try again; layers already downloaded are kept.${reasonSuffix(err)}`,
        'runtime_unreachable'
      )
    } finally {
      signal?.removeEventListener('abort', onAbort)
      void reader.cancel().catch(() => undefined)
    }

    if (signal?.aborted) return cancelled()
    const { completed, total } = totals()
    // Ollama always ends with {"status":"success"}; also accept a stream that ended
    // with every known byte received. Anything else was cut short.
    if (sawSuccess || (total > 0 && completed >= total)) {
      onProgress({ status: 'success', phase: 'done', done: true })
      return
    }
    failed('Ollama closed the connection before the pull finished. Try again; downloaded layers are kept.')
  }

  modelsDir(): string | undefined {
    if (this.options.modelsDir) return this.options.modelsDir
    return isLoopbackUrl(this.baseUrl) ? ollamaModelsDir() : undefined
  }

  /**
   * The registry lists every layer with its size, so the full download is known up
   * front. Layers Ollama already has, finished or half-fetched, are not counted
   * again, which keeps a retry from being refused for space it no longer needs.
   */
  async estimatePull(modelId: string, signal?: AbortSignal): Promise<PullEstimate | undefined> {
    const ref = parseOllamaModelRef(modelId)
    if (!ref) return undefined
    const blobs = await fetchOllamaManifest(ref, {
      ...(this.options.registryFetch ? { fetch: this.options.registryFetch } : {}),
      ...(signal ? { signal } : {})
    })
    if (!blobs) return undefined
    const totalBytes = blobs.reduce((sum, blob) => sum + blob.size, 0)
    const dir = this.modelsDir()
    const present = dir ? await blobBytesOnDisk(dir, blobs) : 0
    return { totalBytes, remainingBytes: Math.max(0, totalBytes - present), source: 'registry' }
  }

  async deleteModel(modelId: string): Promise<void> {
    const res = await fetch(this.url('/api/delete'), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: modelId })
    })
    if (!res.ok) throw new Error(`Ollama /api/delete returned ${res.status}`)
  }
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    if (typeof res.text !== 'function') return ''
    const text = (await res.text()).trim()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text) as { error?: string }
      return parsed.error ? `: ${parsed.error}` : `: ${text.slice(0, 200)}`
    } catch {
      return `: ${text.slice(0, 200)}`
    }
  } catch {
    return ''
  }
}

function safeParse(line: string): OllamaPullLine | null {
  try {
    return JSON.parse(line) as OllamaPullLine
  } catch {
    return null
  }
}

/** The system's reason in brackets, unless it only repeats that the request failed. */
function reasonSuffix(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return reason && reason !== 'fetch failed' ? ` (${reason})` : ''
}
