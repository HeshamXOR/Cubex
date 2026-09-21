import { nanoid } from 'nanoid'
import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { Quantization } from '../../types/common'
import type { ProviderConfig, ProviderKind, ValidationResult } from '../../types/provider'
import type { AIRequest, RequestOptions } from '../../types/request'
import type { AIStreamEvent } from '../../types/stream'
import type { Usage } from '../../types/response'
import type { MessageContentPart } from '../../types/content'
import type { ToolDefinition } from '../../types/tools'
import { extractText } from '../../builders'
import { normalizeUnknownError } from '../../errors/normalize'
import { withTimeout } from '../../util/timeout'
import { BaseProvider, normalizeBaseUrl } from '../base'

const DEFAULT_BASE = 'http://127.0.0.1:11434'

const CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'json_mode',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

// --- Native Ollama /api/chat shapes ---

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

export interface OllamaChatBody {
  model: string
  messages: OllamaMessage[]
  stream: boolean
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }>
  options?: Record<string, unknown>
  format?: string | Record<string, unknown>
}

export interface OllamaChatLine {
  model?: string
  created_at?: string
  message?: { role?: string; content?: string; tool_calls?: OllamaMessage['tool_calls'] }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

function toOllamaTools(tools: ToolDefinition[] | undefined): OllamaChatBody['tools'] {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema as Record<string, unknown>
    }
  }))
}

/** Map unified content parts into an Ollama message (text content + base64 images). */
function toOllamaMessage(role: OllamaMessage['role'], parts: MessageContentPart[]): OllamaMessage {
  const images: string[] = []
  const toolCalls: NonNullable<OllamaMessage['tool_calls']> = []
  for (const p of parts) {
    if (p.type === 'image' && p.source.kind === 'base64') images.push(p.source.data)
    else if (p.type === 'tool_use') {
      toolCalls.push({ function: { name: p.name, arguments: (p.input ?? {}) as Record<string, unknown> } })
    }
  }
  const msg: OllamaMessage = { role, content: extractText(parts) }
  if (images.length > 0) msg.images = images
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

/** Build the native /api/chat request body from the unified request. */
export function toOllamaChatBody(request: AIRequest, stream: boolean): OllamaChatBody {
  const params = request.params ?? {}
  const messages: OllamaMessage[] = []

  if (request.system !== undefined) {
    const text = typeof request.system === 'string' ? request.system : extractText(request.system)
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const m of request.messages) {
    if (m.role === 'developer' || m.role === 'system') {
      messages.push({ role: 'system', content: extractText(m.content) })
    } else if (m.role === 'tool') {
      // Ollama expects tool results as `tool` role messages with text content.
      for (const p of m.content) {
        if (p.type === 'tool_result') {
          messages.push({ role: 'tool', content: extractText(p.content) })
        }
      }
    } else {
      messages.push(toOllamaMessage(m.role, m.content))
    }
  }

  const options: Record<string, unknown> = {}
  if (params.temperature !== undefined) options.temperature = params.temperature
  if (params.topP !== undefined) options.top_p = params.topP
  if (params.topK !== undefined) options.top_k = params.topK
  if (params.maxOutputTokens !== undefined) options.num_predict = params.maxOutputTokens
  if (params.stopSequences && params.stopSequences.length > 0) options.stop = params.stopSequences
  if (params.seed !== undefined) options.seed = params.seed

  const body: OllamaChatBody = { model: request.model, messages, stream }
  const tools = toOllamaTools(request.tools)
  if (tools) body.tools = tools
  if (Object.keys(options).length > 0) body.options = options
  // json_object -> Ollama structured "format": "json"; json_schema -> pass schema object.
  const rf = request.responseFormat
  if (rf?.type === 'json_object') body.format = 'json'
  else if (rf?.type === 'json_schema') body.format = rf.schema as Record<string, unknown>

  return body
}

/** Map a final Ollama line's eval counts to unified Usage. */
export function mapOllamaUsage(line: OllamaChatLine): Usage | undefined {
  const inputTokens = line.prompt_eval_count
  const outputTokens = line.eval_count
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const usage: Usage = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  return usage
}

/**
 * Parse a newline-delimited-JSON (NDJSON) HTTP body into objects. Ollama streams
 * one JSON object per line (NOT SSE), so we split on newlines and JSON.parse each.
 */
export async function* parseNdjson<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<T> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (options.signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try {
            yield JSON.parse(line) as T
          } catch {
            // ignore malformed / partial lines
          }
        }
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        yield JSON.parse(tail) as T
      } catch {
        // ignore
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/** Parse a model tag (e.g. "llama3.1:8b-instruct-q4_K_M") for size/quant hints. */
function parseTag(name: string, details?: { parameter_size?: string; quantization_level?: string }): {
  parameterCount?: number
  quantization?: Quantization
} {
  const out: { parameterCount?: number; quantization?: Quantization } = {}
  const sizeStr = details?.parameter_size ?? name.match(/(\d+(?:\.\d+)?)\s*[bB]\b/)?.[0]
  if (sizeStr) {
    const num = parseFloat(sizeStr)
    if (!Number.isNaN(num)) out.parameterCount = num
  }
  const quant = details?.quantization_level ?? name.match(/[qQ]\d[_a-zA-Z0-9]*/)?.[0]
  if (quant) out.quantization = quant as Quantization
  return out
}

/**
 * Ollama local-runtime adapter. Raw fetch against a local Ollama server; models
 * are `location: 'local'`. Streams NDJSON from /api/chat.
 */
export class OllamaProvider extends BaseProvider {
  readonly kind: ProviderKind = 'ollama'
  readonly id: string
  readonly name: string

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly cfg: ProviderConfig,
    _secret?: string
  ) {
    super()
    this.id = cfg.id
    this.name = cfg.name
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl, DEFAULT_BASE)
    this.setCapabilities(cfg.capabilities ?? CAPS)
    this.fetchImpl = globalThis.fetch
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`)
      if (!res.ok) return []
      const json = (await res.json()) as {
        models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }>
      }
      return (json.models ?? []).map((m) => {
        const parsed = parseTag(m.name, m.details)
        return {
          id: m.name,
          providerId: this.id,
          displayName: m.name,
          ...(m.details?.family ? { family: m.details.family } : {}),
          location: 'local' as const,
          capabilities: CAPS,
          modalities: { input: ['text'], output: ['text'] },
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsReasoning: false,
          ...(parsed.parameterCount !== undefined ? { parameterCount: parsed.parameterCount } : {}),
          ...(parsed.quantization ? { quantization: parsed.quantization } : {}),
          ...(m.size ? { diskSizeBytes: m.size } : {}),
          ...(m.details?.family ? { architecture: m.details.family } : {})
        }
      })
    } catch (err) {
      throw this.wrap(err)
    }
  }

  async *streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent> {
    const signal0 = options?.signal
    if (signal0?.aborted) throw this.abort()

    const { signal, clear } = withTimeout(options?.timeout, options?.signal)
    const body = toOllamaChatBody(request, true)

    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      clear()
      throw this.wrap(err)
    }

    if (!res.ok) {
      clear()
      const text = await res.text().catch(() => '')
      throw new NormalizedAIError({
        provider: this.id,
        category: res.status >= 500 ? 'LOCAL_RUNTIME_ERROR' : 'INVALID_REQUEST',
        message: `Ollama responded ${res.status}${text ? `: ${text}` : ''}`,
        classification: res.status >= 500 ? 'unknown' : 'permanent',
        statusCode: res.status,
        retryable: false
      })
    }

    try {
      yield { type: 'start', provider: this.id, model: request.model }
      let usage: Usage | undefined
      let toolIndex = 0
      for await (const line of parseNdjson<OllamaChatLine>(res.body, { signal })) {
        const content = line.message?.content
        if (content) yield { type: 'text_delta', text: content }
        const toolCalls = line.message?.tool_calls
        if (toolCalls) {
          for (const tc of toolCalls) {
            const idx = toolIndex++
            yield {
              type: 'tool_call_delta',
              index: idx,
              id: `call_${nanoid(6)}`,
              name: tc.function.name,
              argsDelta: JSON.stringify(tc.function.arguments ?? {})
            }
          }
        }
        if (line.done) {
          const u = mapOllamaUsage(line)
          if (u) usage = u
        }
      }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'stop', stopReason: 'stop' }
    } catch (err) {
      throw this.wrap(err)
    } finally {
      clear()
    }
  }

  async validateConfiguration(): Promise<ValidationResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { ok: false, message: `Ollama not reachable at ${this.baseUrl}` }
      const json = (await res.json().catch(() => ({}))) as { version?: string }
      return { ok: true, details: { endpoint: this.baseUrl, ...(json.version ? { version: json.version } : {}) } }
    } catch {
      return { ok: false, message: `Ollama not reachable at ${this.baseUrl}` }
    }
  }

  private abort(): NormalizedAIError {
    return new NormalizedAIError({
      provider: this.id,
      category: 'CANCELLED',
      message: 'Generation stopped',
      classification: 'permanent',
      retryable: false
    })
  }

  /** Normalize errors; turn connection failures into a clear LOCAL_RUNTIME_ERROR. */
  private wrap(err: unknown): NormalizedAIError {
    const norm = normalizeUnknownError(this.id, err)
    if (norm.category === 'CANCELLED') return norm
    if (norm.category === 'NETWORK_ERROR') {
      return new NormalizedAIError({
        provider: this.id,
        category: 'LOCAL_RUNTIME_ERROR',
        message: `Cannot reach Ollama at ${this.baseUrl}. Is the Ollama server running?`,
        classification: 'unknown',
        retryable: false,
        cause: err
      })
    }
    return norm
  }
}
