import { describe, expect, it } from 'vitest'
import { mapStopReason, toAnthMessages, toAnthropicParams, toAnthSystem } from './translate'
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
