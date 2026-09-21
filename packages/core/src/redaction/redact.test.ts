import { describe, expect, it } from 'vitest'
import { REDACTED, redactHeaders, redactObject, redactString } from './redact'

describe('redactString', () => {
  it('redacts OpenAI-style keys', () => {
    expect(redactString('key is sk-abcdef1234567890ABCDEF here')).toContain(REDACTED)
    expect(redactString('key is sk-abcdef1234567890ABCDEF here')).not.toContain('sk-abcdef')
  })
  it('redacts Anthropic-style keys', () => {
    expect(redactString('sk-ant-api03-XXXXXXXXXXXXXXXXXXXX')).toContain(REDACTED)
  })
  it('redacts bearer tokens and HF/GitHub tokens', () => {
    expect(redactString('Authorization: Bearer abcdef012345678')).toContain(REDACTED)
    expect(redactString('hf_ABCDEFGHIJKLMNOPQRST')).toContain(REDACTED)
    expect(redactString('ghp_ABCDEFGHIJKLMNOPQRSTUVWX')).toContain(REDACTED)
  })
  it('leaves innocuous text intact', () => {
    expect(redactString('hello world')).toBe('hello world')
  })
})

describe('redactHeaders', () => {
  it('redacts sensitive header keys regardless of value', () => {
    const out = redactHeaders({
      Authorization: 'Bearer secret',
      'x-api-key': 'anything',
      'content-type': 'application/json',
      cookie: 'session=abc'
    })
    expect(out['Authorization']).toBe(REDACTED)
    expect(out['x-api-key']).toBe(REDACTED)
    expect(out['cookie']).toBe(REDACTED)
    expect(out['content-type']).toBe('application/json')
  })

  it('handles a Headers instance', () => {
    const h = new Headers({ authorization: 'Bearer z', accept: 'text/event-stream' })
    const out = redactHeaders(h)
    expect(out['authorization']).toBe(REDACTED)
    expect(out['accept']).toBe('text/event-stream')
  })
})

describe('redactObject', () => {
  it('deeply redacts sensitive keys and secret-like values', () => {
    const input = {
      model: 'gpt-4o',
      apiKey: 'sk-shouldberedacted1234567',
      nested: { authorization: 'Bearer tok', note: 'contains sk-ant-api03-ABCDEFGHIJKLMNOP token' },
      list: [{ password: 'p' }, 'plain']
    }
    const out = redactObject(input) as typeof input
    expect(out.model).toBe('gpt-4o')
    expect(out.apiKey).toBe(REDACTED)
    expect(out.nested.authorization).toBe(REDACTED)
    expect(out.nested.note).toContain(REDACTED)
    expect((out.list[0] as { password: string }).password).toBe(REDACTED)
    expect(out.list[1]).toBe('plain')
  })

  it('handles circular references safely', () => {
    const a: Record<string, unknown> = { name: 'x' }
    a.self = a
    const out = redactObject(a) as Record<string, unknown>
    expect(out.name).toBe('x')
    expect(out.self).toBe('«circular»')
  })
})
