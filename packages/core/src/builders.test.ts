import { describe, expect, it } from 'vitest'
import { assistantTurn } from './builders'
import type { AIResponse, MessageContentPart, ToolCall } from './types'

function response(content: MessageContentPart[], toolCalls: ToolCall[] = [], text = ''): Pick<AIResponse, 'content' | 'text' | 'toolCalls'> {
  return { content, text, toolCalls }
}

const callA: ToolCall = { id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } }
const callB: ToolCall = { id: 'toolu_B', name: 'read_file', input: { path: 'b.ts' } }

describe('assistantTurn', () => {
  it('replays blocks in the order the model produced them, thinking untouched', () => {
    const content: MessageContentPart[] = [
      { type: 'reasoning', text: 'first', signature: 'sig-A' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
      { type: 'reasoning', text: 'second', signature: 'sig-B' },
      { type: 'tool_use', id: 'toolu_B', name: 'read_file', input: { path: 'b.ts' } }
    ]
    expect(assistantTurn(response(content, [callA, callB]))).toEqual({ role: 'assistant', content })
  })

  it('keeps text where it sits between tool calls', () => {
    const content: MessageContentPart[] = [
      { type: 'text', text: 'Reading a.' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'text', text: 'Now b.' },
      { type: 'tool_use', id: 'toolu_B', name: 'read_file', input: { path: 'b.ts' } }
    ]
    expect(assistantTurn(response(content, [callA, callB], 'Reading a.Now b.')).content).toEqual(content)
  })

  it('keeps unsigned reasoning for providers that echo it back', () => {
    const content: MessageContentPart[] = [{ type: 'reasoning', text: 'plain' }, { type: 'tool_use', ...callA }]
    expect(assistantTurn(response(content, [callA])).content).toEqual(content)
  })

  it('appends calls recovered from text that have no tool_use block', () => {
    const turn = assistantTurn(
      response([{ type: 'text', text: '<invoke name="read_file">' }], [], '<invoke name="read_file">'),
      [callA]
    )
    expect(turn.content).toEqual([
      { type: 'text', text: '<invoke name="read_file">' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } }
    ])
  })

  it('does not duplicate a call that already has a block', () => {
    const content: MessageContentPart[] = [{ type: 'tool_use', ...callA }]
    expect(assistantTurn(response(content, [callA]), [callA]).content).toHaveLength(1)
  })

  it('falls back to text then calls for responses built without content blocks', () => {
    expect(assistantTurn(response([], [callA], 'Looking.')).content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } }
    ])
  })

  it('leaves out parts an assistant never produces', () => {
    const content: MessageContentPart[] = [
      { type: 'image', source: { kind: 'url', url: 'https://example.test/x.png' } },
      { type: 'text', text: 'ok' }
    ]
    expect(assistantTurn(response(content, [], 'ok')).content).toEqual([{ type: 'text', text: 'ok' }])
  })
})
