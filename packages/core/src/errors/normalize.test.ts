import { describe, expect, it } from 'vitest'
import {
  categoryFromStatus,
  classify,
  normalizeHttpError,
  normalizeUnknownError,
  parseRetryAfter
} from './normalize'

describe('classify', () => {
  it('maps categories to transient/permanent/unknown', () => {
    expect(classify('RATE_LIMIT_ERROR')).toBe('transient')
    expect(classify('SERVER_ERROR')).toBe('transient')
    expect(classify('TIMEOUT')).toBe('transient')
    expect(classify('AUTHENTICATION_ERROR')).toBe('permanent')
    expect(classify('INVALID_REQUEST')).toBe('permanent')
    expect(classify('MODEL_NOT_FOUND')).toBe('permanent')
    expect(classify('UNKNOWN')).toBe('unknown')
    expect(classify('LOCAL_RUNTIME_ERROR')).toBe('unknown')
  })
})

describe('categoryFromStatus', () => {
  it('maps HTTP codes', () => {
    expect(categoryFromStatus(401)).toBe('AUTHENTICATION_ERROR')
    expect(categoryFromStatus(403)).toBe('AUTHORIZATION_ERROR')
    expect(categoryFromStatus(404)).toBe('MODEL_NOT_FOUND')
    expect(categoryFromStatus(408)).toBe('TIMEOUT')
    expect(categoryFromStatus(429)).toBe('RATE_LIMIT_ERROR')
    expect(categoryFromStatus(400)).toBe('INVALID_REQUEST')
    expect(categoryFromStatus(500)).toBe('SERVER_ERROR')
    expect(categoryFromStatus(503)).toBe('SERVER_ERROR')
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter(3)).toBe(3000)
  })
  it('parses HTTP-date relative to now', () => {
    const now = Date.now()
    const future = new Date(now + 10_000).toUTCString()
    const ms = parseRetryAfter(future, now)
    expect(ms).toBeGreaterThanOrEqual(9000)
    expect(ms).toBeLessThanOrEqual(11_000)
  })
  it('returns undefined for garbage/nullish', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('not-a-date')).toBeUndefined()
  })
})

describe('normalizeHttpError', () => {
  it('normalizes a 429 with Retry-After as transient + retryable', () => {
    const e = normalizeHttpError({
      provider: 'openai',
      status: 429,
      headers: { 'retry-after': '2', 'x-request-id': 'req_123' },
      body: { error: { message: 'slow down', code: 'rate_limit_exceeded' } }
    })
    expect(e.category).toBe('RATE_LIMIT_ERROR')
    expect(e.classification).toBe('transient')
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(2000)
    expect(e.requestId).toBe('req_123')
    expect(e.rawCode).toBe('rate_limit_exceeded')
  })

  it('normalizes a 401 as permanent auth error', () => {
    const e = normalizeHttpError({
      provider: 'anthropic',
      status: 401,
      body: { error: { message: 'invalid x-api-key', type: 'authentication_error' } }
    })
    expect(e.category).toBe('AUTHENTICATION_ERROR')
    expect(e.classification).toBe('permanent')
    expect(e.retryable).toBe(false)
  })

  it('refines context-length errors from the provider code', () => {
    const e = normalizeHttpError({
      provider: 'openai',
      status: 400,
      body: { error: { message: 'too many tokens', code: 'context_length_exceeded' } }
    })
    expect(e.category).toBe('CONTEXT_LENGTH')
    expect(e.classification).toBe('permanent')
  })

  it('reads request id from anthropic header', () => {
    const e = normalizeHttpError({
      provider: 'anthropic',
      status: 500,
      headers: { 'anthropic-request-id': 'ant_req_9' }
    })
    expect(e.requestId).toBe('ant_req_9')
    expect(e.classification).toBe('transient')
  })
})

describe('normalizeUnknownError', () => {
  it('maps AbortError to CANCELLED', () => {
    const e = normalizeUnknownError('mock', new DOMException('Aborted', 'AbortError'))
    expect(e.category).toBe('CANCELLED')
    expect(e.retryable).toBe(false)
  })
  it('maps ECONNREFUSED to NETWORK_ERROR (transient)', () => {
    const e = normalizeUnknownError('ollama', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    expect(e.category).toBe('NETWORK_ERROR')
    expect(e.classification).toBe('transient')
    expect(e.retryable).toBe(true)
  })
  it('maps timeouts to TIMEOUT', () => {
    const e = normalizeUnknownError('x', Object.assign(new Error('socket timeout'), { name: 'TimeoutError' }))
    expect(e.category).toBe('TIMEOUT')
  })
  it('passes through an existing NormalizedAIError', () => {
    const original = normalizeHttpError({ provider: 'p', status: 500 })
    expect(normalizeUnknownError('p', original)).toBe(original)
  })
})
