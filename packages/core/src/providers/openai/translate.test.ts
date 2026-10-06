import { describe, expect, it } from 'vitest'
import { mapFinishReason, toChatCompletionsBody, toChatMessages, toResponsesInput } from './translate'
import { userMessage } from '../../builders'
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

describe('history that carries thinking from another provider', () => {
  const history: AIRequest = {
    model: 'gpt-5.6',
    messages: [
      userMessage('Fix it'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'summary of signed thinking', signature: 'sig-A' },
          { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
          { type: 'reasoning', text: 'plain reasoning text' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
        ]
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] }
    ]
  }

  it('sends none of it over Chat Completions, which has no field for it', () => {
    const wire = JSON.stringify(toChatMessages(history))
    for (const leaked of ['signed thinking', 'ENCRYPTED', 'plain reasoning', 'sig-A', 'reasoning']) expect(wire).not.toContain(leaked)
    expect(toChatMessages(history)[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] })
  })

  it('sends none of it to the Responses API either', () => {
    const wire = JSON.stringify(toResponsesInput(history))
    for (const leaked of ['signed thinking', 'ENCRYPTED', 'plain reasoning', 'sig-A', 'reasoning']) expect(wire).not.toContain(leaked)
    expect(toResponsesInput(history).map((item) => item.type)).toEqual(['message', 'function_call', 'function_call_output'])
  })
})
