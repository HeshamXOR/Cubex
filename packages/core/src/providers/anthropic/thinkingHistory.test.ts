import { describe, expect, it } from 'vitest'
import { isThinkingHistoryError, toAnthMessages, toAnthropicParams, withoutThinking } from './translate'
import { userMessage } from '../../builders'
import type { AIMessage } from '../../types/message'

const call = { type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
const toolResult: AIMessage = {
  role: 'tool',
  content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }]
}

const translate = (...messages: AIMessage[]) => toAnthMessages({ model: 'claude-opus-5', messages })

describe('toAnthMessages with reasoning from other providers', () => {
  it('drops reasoning that carries no Anthropic signature', () => {
    const messages = translate(
      userMessage('Fix it'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'a summary some other model wrote' }, call] },
      toolResult
    )
    expect(messages[1]!.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }])
  })

  it('keeps signed and redacted thinking where they sit', () => {
    const messages = translate(userMessage('Fix it'), {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
        { type: 'reasoning', text: 'plan', signature: 'sig-A' },
        call
      ]
    })
    expect(messages[1]!.content).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED' },
      { type: 'thinking', thinking: 'plan', signature: 'sig-A' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
    ])
  })

  it('omits an assistant turn that held nothing but foreign reasoning', () => {
    // An empty assistant message is a 400 ("all messages must have non-empty content").
    const messages = translate(
      userMessage('first'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thought, then no answer' }] },
      userMessage('second')
    )
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
    expect(messages.every((m) => m.content.length > 0)).toBe(true)
  })

  it('never sends a signature another provider tagged as its own, such as a Gemini thought signature', () => {
    // Anthropic signatures are base64 and never hold a colon; a tagged one would only 400.
    const messages = translate(userMessage('Fix it'), {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', signature: 'gemini:CiQBjz1rX2' },
        { type: 'reasoning', text: 'plan', signature: 'sigAAAA==' },
        call
      ]
    })
    expect(messages[1]!.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sigAAAA==' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
    ])
  })
})

describe('withoutThinking', () => {
  const signed = toAnthropicParams({
    model: 'claude-opus-5',
    messages: [
      userMessage('Fix it'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan', signature: 'sig-A' },
          { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
          { type: 'text', text: 'Reading.' },
          call
        ]
      },
      toolResult
    ],
    params: { reasoningEffort: 'high' }
  }, true)

  it('removes the thinking parameter and every thinking block, and nothing else', () => {
    const plain = withoutThinking(signed)!
    expect(plain).not.toHaveProperty('thinking')
    expect(plain.output_config).toEqual(signed.output_config)
    expect(plain.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(plain.messages[1]!.content.map((b) => b.type)).toEqual(['text', 'tool_use'])
    expect(plain.messages[2]).toBe(signed.messages[2])
  })

  it('leaves the original request untouched', () => {
    const before = JSON.stringify(signed)
    withoutThinking(signed)
    expect(JSON.stringify(signed)).toBe(before)
  })

  it('drops a turn that was only thinking instead of sending it empty', () => {
    const onlyThinking = {
      ...signed,
      messages: [
        signed.messages[0]!,
        { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'x', signature: 's' } as never] },
        signed.messages[0]!
      ]
    }
    expect(withoutThinking(onlyThinking)!.messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('returns undefined when the request holds no thinking, so there is nothing to retry', () => {
    const { thinking: _thinking, output_config: _effort, ...rest } = signed
    const bare = { ...rest, messages: [signed.messages[0]!, { role: 'assistant' as const, content: [call] }, signed.messages[2]!] }
    expect(withoutThinking(bare)).toBeUndefined()
  })
})

describe('isThinkingHistoryError', () => {
  it('matches the documented messages by their stable fragments', () => {
    expect(isThinkingHistoryError('messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.')).toBe(true)
    expect(isThinkingHistoryError('messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.')).toBe(true)
    expect(isThinkingHistoryError('messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`.')).toBe(true)
  })

  it('ignores 400s that are about something else', () => {
    expect(isThinkingHistoryError('max_tokens: 999999 > 128000, which is the maximum allowed number of output tokens')).toBe(false)
    expect(isThinkingHistoryError('"thinking.type.enabled" is not supported for this model.')).toBe(false)
    expect(isThinkingHistoryError('adaptive thinking is not supported on this model')).toBe(false)
  })
})
