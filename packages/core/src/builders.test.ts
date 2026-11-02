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
})
