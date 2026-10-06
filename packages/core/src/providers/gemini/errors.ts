/**
 * Gemini API failures as `NormalizedAIError`s. The API has quirks the generic
 * HTTP mapper cannot see:
 *  - a bad or expired key is a 400 (INVALID_ARGUMENT, reason API_KEY_INVALID), not 401;
 *  - 429 RESOURCE_EXHAUSTED carries the wait in a `RetryInfo` detail ("34s"), and
 *    a *daily* quota will not clear in seconds, so it must not be retried;
 *  - a blocked prompt or a stopped response is HTTP 200 with a `blockReason` or
 *    `finishReason`, and the ratings say which safety category tripped.
 * Messages are redacted: error text can echo the key that was sent.
 */
import { categoryFromStatus, classify, parseRetryAfter } from '../../errors/normalize'
import { redactString } from '../../redaction/redact'
import { NormalizedAIError, type ErrorCategory } from '../../types/errors'

type Json = Record<string, unknown>

export interface GeminiSafetyRating {
  category?: string
  probability?: string
  blocked?: boolean
}

export interface GeminiHttpErrorInput {
  provider: string
  status: number
  headers?: Headers | Record<string, string | undefined>
  body?: unknown
}

export interface GeminiStopInfo {
  /** `promptFeedback.blockReason`: the prompt was refused and there are no candidates. */
  blockReason?: string
  /** `candidates[0].finishReason`. */
  finishReason?: string
  finishMessage?: string
  ratings?: GeminiSafetyRating[]
}

const MAX_MESSAGE = 300

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function headerValue(headers: GeminiHttpErrorInput['headers'], name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return undefined
}

interface ErrorFields {
  message?: string
  /** google.rpc.Code name, e.g. RESOURCE_EXHAUSTED. */
  status?: string
  details: Json[]
}

/** The error object of a response body: `{error: {...}}`, a one-element array of it, or plain text. */
function errorFields(body: unknown): ErrorFields {
  if (typeof body === 'string') return { message: body.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE), details: [] }
  const root = Array.isArray(body) ? body[0] : body
  if (!isObject(root)) return { details: [] }
  const error = isObject(root.error) ? root.error : root
  return {
    ...(typeof error.message === 'string' ? { message: error.message.slice(0, 1000) } : {}),
    ...(typeof error.status === 'string' ? { status: error.status } : {}),
    details: Array.isArray(error.details) ? error.details.filter(isObject) : []
  }
}

function detailOfType(details: Json[], suffix: string): Json | undefined {
  return details.find((detail) => typeof detail['@type'] === 'string' && detail['@type'].endsWith(suffix))
}

/** A protobuf Duration as JSON: "34s", "0.5s", or {seconds, nanos}. */
function durationMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
    return match ? Math.ceil(Number((Number(match[1]) * 1000).toFixed(3))) : undefined
  }
  if (isObject(value)) {
    const seconds = Number(value.seconds ?? 0)
    const nanos = Number(value.nanos ?? 0)
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return Math.ceil(Number((seconds * 1000 + nanos / 1e6).toFixed(3)))
  }
  return undefined
}

function retryDelayMs(fields: ErrorFields, headers: GeminiHttpErrorInput['headers']): number | undefined {
  const fromDetail = durationMs(detailOfType(fields.details, 'RetryInfo')?.retryDelay)
  if (fromDetail !== undefined) return fromDetail
  const fromHeader = parseRetryAfter(headerValue(headers, 'retry-after'))
  if (fromHeader !== undefined) return fromHeader
  const inMessage = /retry in ([\d.]+)\s*s/i.exec(fields.message ?? '')
  return inMessage ? Math.ceil(Number((Number(inMessage[1]) * 1000).toFixed(3))) : undefined
}

/** True when the quota that ran out resets daily, so waiting seconds will not help. */
function isDailyQuota(fields: ErrorFields): boolean {
  const failure = detailOfType(fields.details, 'QuotaFailure')
  const violations = Array.isArray(failure?.violations) ? failure.violations.filter(isObject) : []
  const named = violations.some((violation) => /per.?day|daily/i.test(`${violation.quotaId ?? ''} ${violation.quotaMetric ?? ''}`))
  return named || /per day|daily/i.test(fields.message ?? '')
}

const KEY_PROBLEM = /api key (not (valid|found)|expired|invalid)|api_key_invalid/i
const TOO_LONG = /exceeds the maximum number of tokens|token count.*exceeds|input.*too (long|large)|request payload size exceeds|context (length|window)/i

function categorize(status: number, googleStatus: string | undefined, reason: string | undefined, message: string): ErrorCategory {
  if (reason === 'API_KEY_INVALID' || KEY_PROBLEM.test(message)) return 'AUTHENTICATION_ERROR'
  if (googleStatus === 'UNAUTHENTICATED' || status === 401) return 'AUTHENTICATION_ERROR'
  if (googleStatus === 'PERMISSION_DENIED' || status === 403) return /api key|leaked/i.test(message) ? 'AUTHENTICATION_ERROR' : 'AUTHORIZATION_ERROR'
  // Region and billing problems come back as FAILED_PRECONDITION.
  if (googleStatus === 'FAILED_PRECONDITION') return 'AUTHORIZATION_ERROR'
  if (googleStatus === 'RESOURCE_EXHAUSTED' || status === 429) return 'RATE_LIMIT_ERROR'
  if (googleStatus === 'DEADLINE_EXCEEDED' || status === 504) return 'TIMEOUT'
  if (googleStatus === 'CANCELLED' || status === 499) return 'CANCELLED'
  if (googleStatus === 'NOT_FOUND' || status === 404) return 'MODEL_NOT_FOUND'
  if (status === 413 || TOO_LONG.test(message)) return 'CONTEXT_LENGTH'
  return categoryFromStatus(status)
}

/** Normalize a non-OK Gemini response (or an in-band error frame, whose `code` is the status). */
export function normalizeGeminiError(input: GeminiHttpErrorInput): NormalizedAIError {
  const fields = errorFields(input.body)
  const reason = detailOfType(fields.details, 'ErrorInfo')?.reason
  const message = fields.message ?? `HTTP ${input.status}`
  const category = categorize(input.status, fields.status, typeof reason === 'string' ? reason : undefined, message)

  const daily = category === 'RATE_LIMIT_ERROR' && isDailyQuota(fields)
  const classification = daily ? 'permanent' : classify(category)
  const retryAfterMs = classification === 'transient' ? retryDelayMs(fields, input.headers) : undefined
  const rawCode = typeof reason === 'string' ? reason : fields.status

  return new NormalizedAIError({
    provider: input.provider,
    category,
    message: redactString(daily ? `${message} (Daily quota reached; retrying will not help until it resets.)` : message),
    classification,
    statusCode: input.status,
    retryable: classification === 'transient',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(rawCode ? { rawCode } : {})
  })
}

/** What the model's refusal is called in the message, by block reason (prompt side). */
const BLOCKED_REQUEST: Record<string, string> = {
  SAFETY: 'blocked the request for safety reasons',
  PROHIBITED_CONTENT: 'blocked the request as prohibited content',
  BLOCKLIST: 'blocked the request because it contains blocked terms',
  IMAGE_SAFETY: 'blocked the request because of unsafe image content',
  OTHER: 'blocked the request for an unspecified reason'
}

/** ... and by finish reason (response side). */
const STOPPED_RESPONSE: Record<string, string> = {
  SAFETY: 'stopped the response for safety reasons',
  RECITATION: 'stopped the response because it would repeat copyrighted material',
  SPII: 'stopped the response because it may contain sensitive personal information',
  PROHIBITED_CONTENT: 'stopped the response because it contained prohibited content',
  BLOCKLIST: 'stopped the response because it contained blocked terms',
  LANGUAGE: 'stopped the response because the language is not supported',
  IMAGE_SAFETY: 'stopped the response because of its image content',
  IMAGE_PROHIBITED_CONTENT: 'stopped the response because of its image content',
  IMAGE_RECITATION: 'stopped the response because of its image content'
}

function categoryLabel(category: string): string {
  return category.replace(/^HARM_CATEGORY_/, '').toLowerCase().replace(/_/g, ' ')
}

/** The safety categories that blocked, or failing that those rated medium or higher. */
function describeRatings(ratings: GeminiSafetyRating[] | undefined): string {
  if (!ratings || ratings.length === 0) return ''
  const blocked = ratings.filter((rating) => rating.blocked === true)
  const flagged = blocked.length > 0 ? blocked : ratings.filter((rating) => rating.probability === 'MEDIUM' || rating.probability === 'HIGH')
  const list = flagged.flatMap((rating) =>
    rating.category ? [`${categoryLabel(rating.category)}${rating.probability ? `: ${rating.probability.toLowerCase()}` : ''}`] : []
  )
  return list.length > 0 ? ` (${list.join(', ')})` : ''
}

function policyError(provider: string, copy: string, rawCode: string, ratings: GeminiSafetyRating[] | undefined): NormalizedAIError {
  return new NormalizedAIError({
    provider,
    category: 'CONTENT_POLICY',
    message: `Gemini ${copy}${describeRatings(ratings)}.`,
    classification: 'permanent',
    retryable: false,
    rawCode
  })
}

function failure(provider: string, category: ErrorCategory, message: string, rawCode: string): NormalizedAIError {
  const classification = classify(category)
  return new NormalizedAIError({ provider, category, message, classification, retryable: classification === 'transient', rawCode })
}

/**
 * The error for a response that was refused or cut off, or undefined for a normal
 * finish (STOP, MAX_TOKENS). The caller decides whether partial output makes a
 * safety stop a graceful end rather than an error.
 */
export function geminiStopError(provider: string, info: GeminiStopInfo): NormalizedAIError | undefined {
  const { blockReason, finishReason } = info
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    return policyError(provider, BLOCKED_REQUEST[blockReason] ?? `blocked the request (${blockReason})`, blockReason, info.ratings)
  }
  if (finishReason === undefined || finishReason === 'STOP' || finishReason === 'MAX_TOKENS') return undefined

  const stopped = STOPPED_RESPONSE[finishReason]
  if (stopped) return policyError(provider, stopped, finishReason, info.ratings)

  const detail = info.finishMessage ? ` ${redactString(info.finishMessage).slice(0, 200)}` : ''
  switch (finishReason) {
    case 'MALFORMED_FUNCTION_CALL':
      return failure(provider, 'STREAM_ERROR', `Gemini produced a malformed tool call.${detail}`, finishReason)
    case 'MISSING_THOUGHT_SIGNATURE':
      return failure(
        provider,
        'INVALID_REQUEST',
        'Gemini rejected the request because a thought signature from an earlier step was missing. Start a new message to continue.',
        finishReason
      )
    case 'UNEXPECTED_TOOL_CALL':
      return failure(provider, 'TOOL_ERROR', 'Gemini called a tool that was not enabled for this request.', finishReason)
    case 'TOO_MANY_TOOL_CALLS':
      return failure(provider, 'TOOL_ERROR', 'Gemini made too many tool calls in a row and was stopped.', finishReason)
    case 'PUP_LIMITED_DISABLED':
      return failure(provider, 'AUTHORIZATION_ERROR', 'Gemini stopped because the account is limited or disabled for policy violations.', finishReason)
    default:
      return failure(provider, 'STREAM_ERROR', `Gemini stopped without an answer (${finishReason}).${detail}`, finishReason)
  }
}
