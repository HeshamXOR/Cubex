import type {
  LocalModelEntry,
  LocalRuntime,
  PullProgressUpdate,
  RuntimeDetection
} from './LocalRuntime'

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
  total?: number
  completed?: number
  error?: string
}

/**
 * Ollama runtime adapter. Talks to the local Ollama HTTP server. Because the
 * server is only reachable when running, we treat "reachable" as running; we
 * cannot distinguish "installed but stopped" over HTTP alone.
 */
export class OllamaRuntime implements LocalRuntime {
  readonly id = 'ollama'
  readonly name = 'Ollama'

  constructor(private readonly baseUrl: string = 'http://127.0.0.1:11434') {}

  private url(path: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl
    return `${base}${path}`
  }

  async detect(): Promise<RuntimeDetection> {
    try {
      const res = await fetch(this.url('/api/version'))
      if (!res.ok) {
        return { installed: true, running: false, endpoint: this.baseUrl, error: `HTTP ${res.status}` }
      }
      const data = (await res.json()) as { version?: string }
      return { installed: true, running: true, endpoint: this.baseUrl, ...(data.version ? { version: data.version } : {}) }
    } catch (err) {
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
      const paramStr = m.details?.parameter_size // e.g. "7B", "3.2B"
      const parameterCount = paramStr ? parseFloat(paramStr) : undefined
      return {
        id: m.name,
        name: m.name,
        runtime: this.id,
        ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
        ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
        ...(parameterCount !== undefined && !Number.isNaN(parameterCount) ? { parameterCount } : {}),
        ...(m.details?.family ? { family: m.details.family } : {}),
        ...(m.modified_at ? { lastUsed: Date.parse(m.modified_at) || undefined } : {})
      }
    })
  }

  async pull(
    modelId: string,
    onProgress: (p: PullProgressUpdate) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(this.url('/api/pull'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: modelId, stream: true }),
      ...(signal ? { signal } : {})
    })
    if (!res.ok || !res.body) {
      onProgress({ status: 'error', done: true, error: `Ollama /api/pull returned ${res.status}` })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastCompleted = 0
    let lastTime = Date.now()

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          const parsed = safeParse(line)
          if (!parsed) continue
          if (parsed.error) {
            onProgress({ status: 'error', done: true, error: parsed.error })
            return
          }
          const now = Date.now()
          const completed = parsed.completed ?? lastCompleted
          const dt = (now - lastTime) / 1000
          const speedBps = dt > 0 && completed >= lastCompleted ? (completed - lastCompleted) / dt : undefined
          const remaining = (parsed.total ?? 0) - completed
          const etaSeconds = speedBps && speedBps > 0 && remaining > 0 ? remaining / speedBps : undefined
          lastCompleted = completed
          lastTime = now
          onProgress({
            status: parsed.status ?? 'pulling',
            ...(parsed.completed !== undefined ? { completedBytes: parsed.completed } : {}),
            ...(parsed.total !== undefined ? { totalBytes: parsed.total } : {}),
            ...(speedBps !== undefined ? { speedBps } : {}),
            ...(etaSeconds !== undefined ? { etaSeconds } : {}),
            done: false
          })
        }
      }
      onProgress({ status: 'success', done: true })
    } catch (err) {
      if (signal?.aborted) {
        onProgress({ status: 'cancelled', done: true })
        return
      }
      onProgress({ status: 'error', done: true, error: String(err) })
    } finally {
      reader.releaseLock()
    }
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

function safeParse(line: string): OllamaPullLine | null {
  try {
    return JSON.parse(line) as OllamaPullLine
  } catch {
    return null
  }
}
