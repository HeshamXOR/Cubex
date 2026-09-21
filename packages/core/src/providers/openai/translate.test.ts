import { describe, expect, it } from 'vitest'
import { mapFinishReason, toChatCompletionsBody, toChatMessages } from './translate'
import { systemMessage, userMessage } from '../../builders'
import type { AIRequest } from '../../types/request'

const base: AIRequest = {
  model: 'gpt-4o',
  system: 'You are terse.',
  messages: [userMessage('Hello')]
}

describe('toChatMessages', () => {
  it('prepends system as a system role message', () => {
    const msgs = toChatMessages(base)
    expect(msgs[0]).toMatchObject({ role: 'system' })
    expect(msgs.at(-1)).toMatchObject({ role: 'user' })
  })

  it('maps image parts to image_url content', () => {
    const req: AIRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } }
          ]
        }
      ]
    }
    const msgs = toChatMessages(req)
    const content = msgs.at(-1)!.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Array<{ type: string }>
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
  })
})

describe('toChatCompletionsBody', () => {
  it('includes sampling params and stream usage options', () => {
    const body = toChatCompletionsBody(
      { ...base, params: { temperature: 0.3, maxOutputTokens: 100 } },
      { stream: true }
    )
    expect(body.model).toBe('gpt-4o')
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(100)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('translates a json_schema response format', () => {
    const body = toChatCompletionsBody({
      ...base,
      responseFormat: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true }
    })
    expect(body.response_format?.type).toBe('json_schema')
  })

  it('maps tools to function tools', () => {
    const body = toChatCompletionsBody({
      ...base,
      tools: [{ name: 'get_weather', description: 'w', inputSchema: { type: 'object' } }]
    })
    expect(body.tools?.[0]).toMatchObject({ type: 'function' })
  })
})

describe('mapFinishReason', () => {
  it('maps OpenAI finish reasons to unified stop reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('length')).toBe('length')
    expect(mapFinishReason('tool_calls')).toBe('tool_use')
    expect(mapFinishReason('content_filter')).toBe('content_filter')
  })
})
