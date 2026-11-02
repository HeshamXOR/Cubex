import { describe, expect, it } from 'vitest'
import { normalizeHttpError, normalizeUnknownError } from './normalize'

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
})
