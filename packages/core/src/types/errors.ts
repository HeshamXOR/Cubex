/**
 * Every provider fails differently. The gateway/retry/fallback engines only ever
 * see a `NormalizedAIError`, produced by each adapter's `normalizeError()`.
 */

export type ErrorCategory =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'INVALID_REQUEST'
  | 'MODEL_NOT_FOUND'
  | 'CONTEXT_LENGTH'
  | 'CONTENT_POLICY'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'STREAM_ERROR'
  | 'TOOL_ERROR'
  | 'LOCAL_RUNTIME_ERROR'
  | 'INSUFFICIENT_MEMORY'
  | 'UNSUPPORTED_FORMAT'
  | 'CANCELLED'
  | 'UNKNOWN'

/** Retry classification derived from the category (and provider hints). */
export type RetryClassification = 'transient' | 'permanent' | 'unknown'

export interface NormalizedAIErrorData {
  provider: string
  category: ErrorCategory
  message: string
  classification: RetryClassification
  statusCode?: number
  retryable: boolean
  /** Seconds to wait, parsed from Retry-After when present. */
  retryAfterMs?: number
  requestId?: string
  /** Provider-specific error code (e.g. "invalid_api_key"). */
  rawCode?: string
  /** Underlying error for developer mode (redacted before display). */
  cause?: unknown
}

export class NormalizedAIError extends Error implements NormalizedAIErrorData {
  readonly provider: string
  readonly category: ErrorCategory
  readonly classification: RetryClassification
  readonly statusCode?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly rawCode?: string
  override readonly cause?: unknown

  constructor(data: NormalizedAIErrorData) {
    super(data.message)
    this.name = 'NormalizedAIError'
    this.provider = data.provider
    this.category = data.category
    this.classification = data.classification
    this.statusCode = data.statusCode
    this.retryable = data.retryable
    this.retryAfterMs = data.retryAfterMs
    this.requestId = data.requestId
    this.rawCode = data.rawCode
    this.cause = data.cause
  }

  toJSON(): Omit<NormalizedAIErrorData, 'cause'> {
    return {
      provider: this.provider,
      category: this.category,
      message: this.message,
      classification: this.classification,
      statusCode: this.statusCode,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      rawCode: this.rawCode
    }
  }
}

export function isNormalizedAIError(e: unknown): e is NormalizedAIError {
  return e instanceof NormalizedAIError
}
