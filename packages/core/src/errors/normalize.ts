import {
  NormalizedAIError,
  type ErrorCategory,
  type RetryClassification
} from '../types/errors'

const TRANSIENT: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'RATE_LIMIT_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'STREAM_ERROR'
])

const PERMANENT: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
  'CONTEXT_LENGTH',
  'CONTENT_POLICY',
  'UNSUPPORTED_FORMAT',
  'CANCELLED',
  'TOOL_ERROR',
  'INSUFFICIENT_MEMORY'
])

export function classify(category: ErrorCategory): RetryClassification {
  if (TRANSIENT.has(category)) return 'transient'
  if (PERMANENT.has(category)) return 'permanent'
  return 'unknown' // UNKNOWN, LOCAL_RUNTIME_ERROR
}

export function categoryFromStatus(status: number): ErrorCategory {
  switch (status) {
    case 400:
    case 422:
      return 'INVALID_REQUEST'
    case 401:
      return 'AUTHENTICATION_ERROR'
    case 403:
      return 'AUTHORIZATION_ERROR'
    case 404:
      return 'MODEL_NOT_FOUND'
    case 408:
      return 'TIMEOUT'
    case 413:
      return 'CONTEXT_LENGTH'
    case 429:
      return 'RATE_LIMIT_ERROR'
    default:
      if (status >= 500) return 'SERVER_ERROR'
      return 'UNKNOWN'
  }
}

/** Parse a Retry-After header value (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: string | number | null | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number') return value >= 0 ? value * 1000 : undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000
  }
  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - now
    return delta > 0 ? delta : 0
  }
  return undefined
}

export interface HttpErrorInput {
  provider: string
  status: number
  headers?: Record<string, string | string[] | undefined> | Headers
  body?: unknown
  requestId?: string
  rawCode?: string
  message?: string
  cause?: unknown
}

function headerGet(headers: HttpErrorInput['headers'], name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

/**
 * OpenRouter wraps a provider's failure: its own `message` is generic and the
 * provider's real text sits in `metadata.raw`, as JSON or plain text.
 */
function upstreamMessage(metadata: unknown): string | undefined {
  const raw = (metadata as { raw?: unknown } | null | undefined)?.raw
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let text = raw.trim()
  try {
    text = extractBodyInfo(JSON.parse(raw)).message ?? text
  } catch {
    /* not JSON: the raw text is the message */
  }
  return text.slice(0, 1000)
}

/** Try to extract a human message + provider code from a JSON error body. */
function extractBodyInfo(body: unknown): { message?: string; code?: string } {
  if (body == null) return {}
  if (typeof body === 'string') return { message: body }
  if (typeof body === 'object') {
    const b = body as Record<string, unknown>
    // Some servers (Ollama, xAI) send `{ "error": "text" }`.
    if (typeof b.error === 'string') return { message: b.error, ...(typeof b.code === 'string' ? { code: b.code } : {}) }
    const err = (b.error ?? b) as Record<string, unknown>
    let message = typeof err.message === 'string' ? err.message : undefined
    const upstream = upstreamMessage(err.metadata)
    if (upstream && !message?.includes(upstream)) message = message ? `${message}: ${upstream}` : upstream
    const code =
      typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : undefined
    return { message, code }
  }
  return {}
}

export function normalizeHttpError(input: HttpErrorInput): NormalizedAIError {
  let category = categoryFromStatus(input.status)
  const { message: bodyMsg, code: bodyCode } = extractBodyInfo(input.body)
  const rawCode = input.rawCode ?? bodyCode

  // Refine category using provider error codes where possible.
  if (rawCode) {
    const c = rawCode.toLowerCase()
    if (c.includes('context_length') || c.includes('max_tokens') || c.includes('too_long')) {
      category = 'CONTEXT_LENGTH'
    } else if (c.includes('content_policy') || c.includes('content_filter') || c.includes('safety')) {
      category = 'CONTENT_POLICY'
    } else if (c.includes('model') && (c.includes('not_found') || c.includes('does_not_exist'))) {
      category = 'MODEL_NOT_FOUND'
    } else if (c.includes('invalid_api_key') || c.includes('authentication')) {
      category = 'AUTHENTICATION_ERROR'
    }
  }

  const classification = classify(category)
  const retryAfterMs = parseRetryAfter(headerGet(input.headers, 'retry-after'))
  const requestId =
    input.requestId ??
    headerGet(input.headers, 'x-request-id') ??
    headerGet(input.headers, 'request-id') ??
    headerGet(input.headers, 'anthropic-request-id')

  return new NormalizedAIError({
    provider: input.provider,
    category,
    message: input.message ?? bodyMsg ?? `HTTP ${input.status}`,
    classification,
    statusCode: input.status,
    retryable: classification === 'transient',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId ? { requestId } : {}),
    ...(rawCode ? { rawCode } : {}),
    cause: input.cause
  })
}

/** Normalize a thrown JS/network error (fetch failure, abort, DNS, timeout). */
export function normalizeUnknownError(provider: string, err: unknown): NormalizedAIError {
  if (err instanceof NormalizedAIError) return err

  const e = err as { name?: string; code?: string; message?: string } | undefined
  const name = e?.name ?? ''
  const code = e?.code ?? ''
  const msg = e?.message ?? String(err)

  let category: ErrorCategory = 'UNKNOWN'
  if (name === 'AbortError' || code === 'ABORT_ERR') category = 'CANCELLED'
  else if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timeout/i.test(msg)) category = 'TIMEOUT'
  else if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    /fetch failed|network|socket hang up/i.test(msg)
  ) {
    category = 'NETWORK_ERROR'
  }

  const classification = classify(category)
  return new NormalizedAIError({
    provider,
    category,
    message: msg,
    classification,
    retryable: classification === 'transient',
    ...(code ? { rawCode: code } : {}),
    cause: err
  })
}
