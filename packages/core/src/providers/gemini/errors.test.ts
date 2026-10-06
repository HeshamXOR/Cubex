import { describe, expect, it } from 'vitest'
import { NormalizedAIError } from '../../types/errors'
import { geminiStopError, normalizeGeminiError } from './errors'

const googleError = (code: number, status: string, message: string, details?: unknown[]): unknown => ({
  error: { code, message, status, ...(details ? { details } : {}) }
})

const retryInfo = (retryDelay: string | { seconds: string; nanos?: number }): unknown => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay
})

const normalize = (status: number, body: unknown, headers?: Record<string, string>): NormalizedAIError =>
  normalizeGeminiError({ provider: 'gem', status, body, ...(headers ? { headers } : {}) })

describe('normalizeGeminiError: status mapping', () => {
  const key = { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }

  it.each([
    // The API answers a bad key with 400, not 401.
    [400, googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [key]), 'AUTHENTICATION_ERROR', 'permanent'],
    [400, googleError(400, 'INVALID_ARGUMENT', 'API key expired. Please renew the API key.'), 'AUTHENTICATION_ERROR', 'permanent'],
    [401, googleError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'), 'AUTHENTICATION_ERROR', 'permanent'],
    [403, googleError(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked. Please use another API key.'), 'AUTHENTICATION_ERROR', 'permanent'],
    [403, googleError(403, 'PERMISSION_DENIED', 'The caller does not have permission'), 'AUTHORIZATION_ERROR', 'permanent'],
    [400, googleError(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), 'AUTHORIZATION_ERROR', 'permanent'],
    [404, googleError(404, 'NOT_FOUND', 'models/nope is not found for API version v1beta, or is not supported for generateContent.'), 'MODEL_NOT_FOUND', 'permanent'],
    [
      400,
      googleError(400, 'INVALID_ARGUMENT', 'The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).'),
      'CONTEXT_LENGTH',
      'permanent'
    ],
    [413, 'Request Entity Too Large', 'CONTEXT_LENGTH', 'permanent'],
    [400, googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "x": Cannot find field.'), 'INVALID_REQUEST', 'permanent'],
    [500, googleError(500, 'INTERNAL', 'An internal error has occurred.'), 'SERVER_ERROR', 'transient'],
    [503, googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'), 'SERVER_ERROR', 'transient'],
    [504, googleError(504, 'DEADLINE_EXCEEDED', 'The service is unable to finish processing within the deadline.'), 'TIMEOUT', 'transient'],
    [502, '<html>Bad gateway</html>', 'SERVER_ERROR', 'transient']
  ])('maps HTTP %i (%#) to %s', (status, body, category, classification) => {
    const error = normalize(status, body)
    expect(error).toBeInstanceOf(NormalizedAIError)
    expect(error.category).toBe(category)
    expect(error.classification).toBe(classification)
    expect(error.retryable).toBe(classification === 'transient')
    expect(error.statusCode).toBe(status)
    expect(error.provider).toBe('gem')
  })

  it('keeps the provider message and the Google status as the raw code', () => {
    const error = normalize(503, googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'))
    expect(error.message).toBe('The model is overloaded. Please try again later.')
    expect(error.rawCode).toBe('UNAVAILABLE')
  })

  it('reports the ErrorInfo reason as the raw code when there is one', () => {
    const error = normalize(400, googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [key]))
    expect(error.rawCode).toBe('API_KEY_INVALID')
  })

  it('truncates a non-JSON body instead of dumping a whole error page', () => {
    const error = normalize(502, `<html>${'x'.repeat(5000)}</html>`)
    expect(error.message.length).toBeLessThan(400)
  })

  it('redacts an API key echoed in the message', () => {
    // Made up, and in two pieces so that secret scanners do not mistake it for a leaked key.
    const leaked = ['AIza', 'SyA12345678901234567890123456789012'].join('')
    const error = normalize(403, googleError(403, 'PERMISSION_DENIED', `Key ${leaked} is not allowed.`))
    expect(error.message).not.toContain(leaked)
  })

  it('handles an in-band error frame whose code is the HTTP status', () => {
    const error = normalizeGeminiError({ provider: 'gem', status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } })
    expect(error.category).toBe('SERVER_ERROR')
    expect(error.retryable).toBe(true)
  })
})

describe('normalizeGeminiError: 429 RESOURCE_EXHAUSTED', () => {
  const exhausted = (details?: unknown[], message = 'You exceeded your current quota.'): unknown =>
    googleError(429, 'RESOURCE_EXHAUSTED', message, details)

  it('is a retryable rate limit that carries the delay the API asked for', () => {
    const error = normalize(429, exhausted([retryInfo('34s')]))
    expect(error.category).toBe('RATE_LIMIT_ERROR')
    expect(error.classification).toBe('transient')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBe(34_000)
    expect(error.rawCode).toBe('RESOURCE_EXHAUSTED')
  })

  it.each([
    ['0.5s', 500],
    ['34.123456789s', 34_124],
    ['2s', 2000],
    ['120s', 120_000]
  ])('reads a retryDelay of %s as %i ms', (delay, ms) => {
    expect(normalize(429, exhausted([retryInfo(delay)])).retryAfterMs).toBe(ms)
  })

  it('reads a Duration object as well as a string', () => {
    expect(normalize(429, exhausted([retryInfo({ seconds: '7', nanos: 500_000_000 })])).retryAfterMs).toBe(7500)
  })

  it('falls back to the delay in the message, then to the Retry-After header', () => {
    expect(normalize(429, exhausted(undefined, 'Quota hit. Please retry in 12.5s.')).retryAfterMs).toBe(12_500)
    expect(normalize(429, exhausted(undefined), { 'retry-after': '9' }).retryAfterMs).toBe(9000)
  })

  it('leaves the delay out when nothing says how long to wait', () => {
    expect(normalize(429, exhausted()).retryAfterMs).toBeUndefined()
  })

  it('does not invite a retry for a daily quota, which no short wait will clear', () => {
    const quota = {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }]
    }
    const error = normalize(429, exhausted([quota, retryInfo('34s')]))
    expect(error.category).toBe('RATE_LIMIT_ERROR')
    expect(error.classification).toBe('permanent')
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(/daily quota/i)
  })

  it('still retries a per-minute quota', () => {
    const quota = {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' }]
    }
    expect(normalize(429, exhausted([quota, retryInfo('20s')])).retryable).toBe(true)
  })
})

describe('geminiStopError', () => {
  const ratings = [
    { category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH', blocked: true },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE' }
  ]

  it('is undefined for the finishes that are not failures', () => {
    expect(geminiStopError('gem', { finishReason: 'STOP' })).toBeUndefined()
    expect(geminiStopError('gem', { finishReason: 'MAX_TOKENS' })).toBeUndefined()
    expect(geminiStopError('gem', {})).toBeUndefined()
  })

  it('turns a blocked prompt into a content policy error naming the categories that blocked it', () => {
    const error = geminiStopError('gem', { blockReason: 'SAFETY', ratings })!
    expect(error.category).toBe('CONTENT_POLICY')
    expect(error.classification).toBe('permanent')
    expect(error.retryable).toBe(false)
    expect(error.rawCode).toBe('SAFETY')
    expect(error.message).toMatch(/blocked/i)
    expect(error.message).toMatch(/harassment/i)
    expect(error.message).not.toMatch(/dangerous content/i)
  })

  it('names the category even when no rating is flagged blocked, if one is medium or higher', () => {
    const error = geminiStopError('gem', {
      blockReason: 'SAFETY',
      ratings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'MEDIUM' }, { category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW' }]
    })!
    expect(error.message).toMatch(/hate speech/i)
    expect(error.message).not.toMatch(/harassment/i)
  })

  it.each([
    [{ blockReason: 'PROHIBITED_CONTENT' }, /prohibited/i],
    [{ blockReason: 'BLOCKLIST' }, /blocklist|blocked terms/i],
    [{ blockReason: 'OTHER' }, /blocked/i],
    [{ finishReason: 'SAFETY' }, /safety/i],
    [{ finishReason: 'RECITATION' }, /recit|copyright/i],
    [{ finishReason: 'SPII' }, /personal/i],
    [{ finishReason: 'PROHIBITED_CONTENT' }, /prohibited/i]
  ])('explains %j', (info, pattern) => {
    const error = geminiStopError('gem', info)!
    expect(error.category).toBe('CONTENT_POLICY')
    expect(error.message).toMatch(pattern)
  })

  it('treats a malformed function call as a retryable model failure', () => {
    const error = geminiStopError('gem', { finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call: call:read_file{' })!
    expect(error.category).toBe('STREAM_ERROR')
    expect(error.retryable).toBe(true)
    expect(error.rawCode).toBe('MALFORMED_FUNCTION_CALL')
  })

  it('treats a missing thought signature as a permanent request problem', () => {
    const error = geminiStopError('gem', { finishReason: 'MISSING_THOUGHT_SIGNATURE' })!
    expect(error.category).toBe('INVALID_REQUEST')
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(/signature/i)
  })

  it.each(['UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS'])('treats %s as a tool error', (finishReason) => {
    expect(geminiStopError('gem', { finishReason })!.category).toBe('TOOL_ERROR')
  })

  it('treats an unexplained stop as a retryable stream failure', () => {
    for (const finishReason of ['OTHER', 'FINISH_REASON_UNSPECIFIED', 'MALFORMED_RESPONSE']) {
      const error = geminiStopError('gem', { finishReason })!
      expect(error.category).toBe('STREAM_ERROR')
      expect(error.retryable).toBe(true)
    }
  })
})
