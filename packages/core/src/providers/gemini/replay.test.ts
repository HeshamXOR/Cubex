import { describe, expect, it } from 'vitest'
import type { AIRequest } from '../../types/request'
import {
  GEMINI_SKIP_SIGNATURE,
  geminiApiCallId,
  geminiCallId,
  packGeminiSignature,
  unpackGeminiSignature,
  withoutGeminiSignatures
} from './replay'

describe('thought signature tagging', () => {
  it('round-trips a signature through the tagged form', () => {
    const packed = packGeminiSignature('CiQBjz1rX3+/abc==')
    expect(packed).not.toBe('CiQBjz1rX3+/abc==')
    expect(unpackGeminiSignature(packed)).toBe('CiQBjz1rX3+/abc==')
  })

  it('refuses a signature another provider wrote (it would be a 400 on Gemini)', () => {
    expect(unpackGeminiSignature('EqoBCkgIBRABGAIiQ...anthropic-signature')).toBeUndefined()
    expect(unpackGeminiSignature('')).toBeUndefined()
    expect(unpackGeminiSignature(undefined)).toBeUndefined()
  })

  it('treats a tag with nothing after it as no signature', () => {
    expect(unpackGeminiSignature(packGeminiSignature(''))).toBeUndefined()
  })

  it('exposes the documented bypass value for calls the model did not make', () => {
    expect(GEMINI_SKIP_SIGNATURE).toBe('skip_thought_signature_validator')
  })
})

describe('geminiCallId', () => {
  const args = { path: 'a.ts', range: { from: 1, to: 9 } }

  it('is deterministic for the same response, position, name and arguments', () => {
    expect(geminiCallId({ name: 'read_file', args }, 0, 'resp-1')).toBe(geminiCallId({ name: 'read_file', args }, 0, 'resp-1'))
  })

  it('ignores argument key order', () => {
    const swapped = { range: { to: 9, from: 1 }, path: 'a.ts' }
    expect(geminiCallId({ name: 'read_file', args: swapped }, 0, 'r')).toBe(geminiCallId({ name: 'read_file', args }, 0, 'r'))
  })

  it('differs by position so identical parallel calls stay distinct', () => {
    expect(geminiCallId({ name: 'read_file', args }, 0, 'r')).not.toBe(geminiCallId({ name: 'read_file', args }, 1, 'r'))
  })

  it('differs by response so a repeated call in a later turn is a new call', () => {
    expect(geminiCallId({ name: 'read_file', args }, 0, 'resp-1')).not.toBe(geminiCallId({ name: 'read_file', args }, 0, 'resp-2'))
  })

  it('differs by name and by arguments', () => {
    const base = geminiCallId({ name: 'read_file', args }, 0, 'r')
    expect(geminiCallId({ name: 'write_file', args }, 0, 'r')).not.toBe(base)
    expect(geminiCallId({ name: 'read_file', args: { path: 'b.ts' } }, 0, 'r')).not.toBe(base)
  })

  it('is short and made of characters every provider accepts in a tool call id', () => {
    const id = geminiCallId({ name: 'x', args: {} }, 3)
    expect(id).toMatch(/^gemini_call_[0-9a-f]{16}$/)
    expect(id.length).toBeLessThanOrEqual(40)
  })

  it('keeps an id the API supplied, so the function response can echo it', () => {
    const id = geminiCallId({ id: 'abc123', name: 'x', args: {} }, 0, 'r')
    expect(id).toBe('gemini_id_abc123')
    expect(geminiApiCallId(id)).toBe('abc123')
  })

  it('does not trust an API id that is too long for other providers', () => {
    const id = geminiCallId({ id: 'x'.repeat(60), name: 'x', args: {} }, 0, 'r')
    expect(id).toMatch(/^gemini_call_/)
  })

  it('does not trust an API id with characters outside the portable set', () => {
    expect(geminiCallId({ id: 'a b/c', name: 'x', args: {} }, 0, 'r')).toMatch(/^gemini_call_/)
  })
})

describe('geminiApiCallId', () => {
  it('returns nothing for synthesized ids and for ids another provider issued', () => {
    expect(geminiApiCallId('gemini_call_0123456789abcdef')).toBeUndefined()
    expect(geminiApiCallId('toolu_01A09q90qw90lq917835lq9')).toBeUndefined()
    expect(geminiApiCallId('call_abc')).toBeUndefined()
  })
})

describe('withoutGeminiSignatures', () => {
  const request: AIRequest = {
    model: 'gemini-3-flash-preview',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'signed summary', signature: packGeminiSignature('S1') },
          { type: 'reasoning', text: 'plain summary' },
          { type: 'reasoning', text: 'x', signature: 'anthropic-signature' },
          { type: 'tool_use', id: 'gemini_call_aaaaaaaaaaaaaaaa', name: 'read_file', input: {} },
          { type: 'reasoning', text: '', signature: packGeminiSignature('S2') }
        ]
      }
    ]
  }

  it('removes the reasoning parts that carry a Gemini signature and nothing else', () => {
    const stripped = withoutGeminiSignatures(request)
    expect(stripped.messages[1]!.content).toEqual([
      { type: 'reasoning', text: 'plain summary' },
      { type: 'reasoning', text: 'x', signature: 'anthropic-signature' },
      { type: 'tool_use', id: 'gemini_call_aaaaaaaaaaaaaaaa', name: 'read_file', input: {} }
    ])
    expect(stripped.messages[0]).toBe(request.messages[0])
  })

  it('does not change the request it was given', () => {
    const before = JSON.stringify(request)
    withoutGeminiSignatures(request)
    expect(JSON.stringify(request)).toBe(before)
  })

  it('returns the very same request when there is nothing to remove', () => {
    const plain: AIRequest = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    expect(withoutGeminiSignatures(plain)).toBe(plain)
  })
})
