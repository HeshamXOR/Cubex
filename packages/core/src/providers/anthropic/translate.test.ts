import { describe, expect, it } from 'vitest'
import { mapAnthUsage, mapStopReason, toAnthMessages, toAnthropicParams, toAnthSystem } from './translate'
import { assistantMessage, userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'

describe('toAnthropicParams (native shape)', () => {
  const req: AIRequest = {
    model: 'claude-sonnet-4',
    system: 'Be concise.',
    messages: [userMessage('Hi')]
  }

  it('always sets max_tokens (Anthropic requires it)', () => {
    const p = toAnthropicParams(req, false)
    expect(p.max_tokens).toBeGreaterThan(0)
  })

  it('honors an explicit maxOutputTokens', () => {
    const p = toAnthropicParams({ ...req, params: { maxOutputTokens: 512 } }, false)
    expect(p.max_tokens).toBe(512)
  })

  it('lifts system to a top-level field, not into messages', () => {
    const p = toAnthropicParams(req, false)
    expect(p.system).toBe('Be concise.')
    // No message should carry a "system" role — Anthropic has no system role in the array.
    expect(p.messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true)
  })

  it('encodes an image content part as a native base64 image block', () => {
    const p = toAnthropicParams(
      {
        model: 'claude-sonnet-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'QUJD' } }
            ]
          }
        ]
      },
      false
    )
    const blocks = p.messages[0]!.content as Array<{ type: string; source?: { type: string; media_type: string; data: string } }>
    const img = blocks.find((b) => b.type === 'image')
    expect(img).toBeTruthy()
    expect(img!.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' })
  })

  it('sets stream flag when requested', () => {
    expect(toAnthropicParams(req, true).stream).toBe(true)
    expect(toAnthropicParams(req, false).stream).toBeUndefined()
  })
})

describe('toAnthMessages tool_result mapping', () => {
  it('maps a tool-role message into user tool_result blocks', () => {
    const req: AIRequest = {
      model: 'claude-sonnet-4',
      messages: [
        userMessage('weather?'),
        assistantMessage([{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Paris' } }]),
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'sunny' }] }]
        }
      ]
    }
    const msgs = toAnthMessages(req)
    const toolMsg = msgs.find((m) =>
      Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result')
    )
    // Anthropic expects tool_result blocks inside a USER message.
    expect(toolMsg?.role).toBe('user')
  })
})

describe('toAnthSystem', () => {
  it('returns the system string', () => {
    expect(toAnthSystem({ model: 'x', system: 'S', messages: [] })).toBe('S')
  })
})

describe('mapStopReason', () => {
  it('maps Anthropic stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('stop')
    expect(mapStopReason('max_tokens')).toBe('length')
    expect(mapStopReason('tool_use')).toBe('tool_use')
    expect(mapStopReason('stop_sequence')).toBe('stop')
  })
})

describe('mapAnthUsage', () => {
  it('normalizes total input while preserving read and write cache subsets', () => {
    expect(mapAnthUsage({ input_tokens: 25, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 50 })).toEqual({
      inputTokens: 1_225,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 200,
      outputTokens: 50,
      totalTokens: 1_275
    })
  })

  it('preserves the full cached input across output-only streaming deltas', () => {
    const start = mapAnthUsage({ input_tokens: 10, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 100, output_tokens: 1 })
    const delta = mapAnthUsage({ input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 30 }, start)
    expect(delta).toMatchObject({ inputTokens: 2_110, cachedInputTokens: 2_000, cacheWriteInputTokens: 100, outputTokens: 30, totalTokens: 2_140 })
    expect(start?.outputTokens).toBe(1)
  })

  it('replaces repeated cumulative counters without counting prompt tokens twice', () => {
    const counters = { input_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 160, output_tokens: 20 }
    const start = mapAnthUsage(counters)
    const repeated = mapAnthUsage(counters, start)
    expect(repeated).toEqual(start)
    const final = mapAnthUsage({ ...counters, input_tokens: 50, cache_creation_input_tokens: 200, output_tokens: 70 }, repeated)
    expect(final).toMatchObject({ inputTokens: 1_050, outputTokens: 70, totalTokens: 1_120 })
  })

  it('merges independently updated cache counters while keeping the uncached component', () => {
    const start = mapAnthUsage({ input_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })
    const cacheUpdate = mapAnthUsage({ cache_read_input_tokens: 150 }, start)
    expect(cacheUpdate).toMatchObject({ inputTokens: 200, cachedInputTokens: 150, cacheWriteInputTokens: 20 })
    expect(mapAnthUsage({ input_tokens: 40 }, cacheUpdate)).toMatchObject({ inputTokens: 210 })
  })

  it('treats explicit zeros as counts and nullable fields as absent', () => {
    const start = mapAnthUsage({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 })
    expect(mapAnthUsage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, start)).toMatchObject({ inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 15 })
    expect(mapAnthUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(mapAnthUsage({ input_tokens: null, cache_read_input_tokens: null })).toBeUndefined()
  })

  it('can merge cache-only and later uncached input reports', () => {
    const cached = mapAnthUsage({ cache_read_input_tokens: 400 })
    expect(cached).toEqual({ inputTokens: 400, cachedInputTokens: 400, totalTokens: 400 })
    expect(mapAnthUsage({ input_tokens: 12, cache_creation_input_tokens: 50 }, cached)).toMatchObject({ inputTokens: 462, totalTokens: 462 })
  })

  it('ignores invalid token counts and does not invent usage for an empty update', () => {
    expect(mapAnthUsage(undefined)).toBeUndefined()
    expect(mapAnthUsage({})).toBeUndefined()
    expect(mapAnthUsage({ input_tokens: NaN, cache_read_input_tokens: -1, cache_creation_input_tokens: Infinity, output_tokens: 0.5 })).toBeUndefined()
    const previous = mapAnthUsage({ input_tokens: 10, output_tokens: 2 })
    expect(mapAnthUsage(null, previous)).toBe(previous)
    expect(mapAnthUsage({ input_tokens: NaN, output_tokens: -1 }, previous)).toEqual(previous)
  })
})
