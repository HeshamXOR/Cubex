import { describe, expect, it } from 'vitest'
import { StreamAccumulator } from './accumulator'
import type { AIStreamEvent } from '../types/stream'

describe('StreamAccumulator', () => {
  it('assembles text and usage into a completed response', () => {
    const acc = new StreamAccumulator('mock', 'mock-large')
    const events: AIStreamEvent[] = [
      { type: 'start', provider: 'mock', model: 'mock-large', requestId: 'r1' },
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'stop', stopReason: 'stop' }
    ]
    for (const e of events) acc.push(e)
    const res = acc.finalize()
    expect(res.text).toBe('Hello world')
    expect(res.requestId).toBe('r1')
    expect(res.usage?.totalTokens).toBe(7)
    expect(res.stopReason).toBe('stop')
    expect(res.timings?.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('assembles streamed tool-call deltas into a tool_use response', () => {
    const acc = new StreamAccumulator('mock', 'm')
    acc.push({ type: 'tool_call_delta', index: 0, id: 'c1', name: 'get_weather' })
    acc.push({ type: 'tool_call_delta', index: 0, argsDelta: '{"location":' })
    acc.push({ type: 'tool_call_delta', index: 0, argsDelta: '"Paris"}' })
    acc.push({ type: 'stop', stopReason: 'tool_use' })
    const res = acc.finalize()
    expect(res.stopReason).toBe('tool_use')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]).toMatchObject({ id: 'c1', name: 'get_weather', input: { location: 'Paris' } })
  })

  it('defaults stopReason to tool_use when tool calls exist but no stop given', () => {
    const acc = new StreamAccumulator('mock', 'm')
    acc.push({ type: 'tool_call', toolCall: { id: 'x', name: 'f', input: {} } })
    expect(acc.finalize().stopReason).toBe('tool_use')
  })

  it('tolerates malformed tool argument JSON', () => {
    const acc = new StreamAccumulator('mock', 'm')
    acc.push({ type: 'tool_call_delta', index: 0, id: 'c', name: 'f', argsDelta: '{bad' })
    const res = acc.finalize()
    expect(res.toolCalls[0]!.input).toMatchObject({ _raw: '{bad' })
  })
})

describe('StreamAccumulator content-block order', () => {
  /** Normalized events as AnthropicProvider emits them for [thinking, tool_use, thinking, tool_use]. */
  const interleaved: AIStreamEvent[] = [
    { type: 'start', provider: 'anthropic', model: 'claude-opus-5', requestId: 'msg_01' },
    { type: 'reasoning_delta', text: 'Need the first file. ' },
    { type: 'reasoning_delta', text: 'Read it.' },
    { type: 'metadata', data: { reasoningBlock: { signature: 'sig-A' } } },
    { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'read_file' },
    { type: 'tool_call_delta', index: 0, argsDelta: '{"path":' },
    { type: 'tool_call_delta', index: 0, argsDelta: '"a.ts"}' },
    { type: 'reasoning_delta', text: 'Now the second file.' },
    { type: 'metadata', data: { reasoningBlock: { signature: 'sig-B' } } },
    { type: 'tool_call_delta', index: 1, id: 'toolu_2', name: 'read_file' },
    { type: 'tool_call_delta', index: 1, argsDelta: '{"path":"b.ts"}' },
    { type: 'stop', stopReason: 'tool_use' }
  ]

  function build(events: AIStreamEvent[]) {
    const acc = new StreamAccumulator('anthropic', 'claude-opus-5')
    for (const e of events) acc.push(e)
    return acc.finalize()
  }

  it('keeps [thinking, tool_use, thinking, tool_use] in stream order', () => {
    const res = build(interleaved)
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'tool_use', 'reasoning', 'tool_use'])
    expect(res.content[0]).toMatchObject({ type: 'reasoning', text: 'Need the first file. Read it.', signature: 'sig-A' })
    expect(res.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', input: { path: 'a.ts' } })
    expect(res.content[2]).toMatchObject({ type: 'reasoning', text: 'Now the second file.', signature: 'sig-B' })
    expect(res.content[3]).toMatchObject({ type: 'tool_use', id: 'toolu_2', input: { path: 'b.ts' } })
    expect(res.toolCalls.map((c) => c.id)).toEqual(['toolu_1', 'toolu_2'])
  })

  it('keeps text between blocks where the model wrote it', () => {
    const res = build([
      { type: 'reasoning_delta', text: 'plan' },
      { type: 'metadata', data: { reasoningBlock: { signature: 'sig-A' } } },
      { type: 'text_delta', text: 'Reading ' },
      { type: 'text_delta', text: 'now.' },
      { type: 'tool_call_delta', index: 0, id: 't1', name: 'read_file', argsDelta: '{}' },
      { type: 'reasoning_delta', text: 'more' },
      { type: 'metadata', data: { reasoningBlock: { signature: 'sig-B' } } },
      { type: 'text_delta', text: 'Done.' }
    ])
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool_use', 'reasoning', 'text'])
    expect(res.text).toBe('Reading now.Done.')
  })

  it('places redacted thinking where it arrived', () => {
    const res = build([
      { type: 'reasoning_delta', text: 'visible' },
      { type: 'metadata', data: { reasoningBlock: { signature: 'sig-A' } } },
      { type: 'metadata', data: { reasoningBlock: { redacted: 'ENCRYPTED' } } },
      { type: 'tool_call_delta', index: 0, id: 't1', name: 'f', argsDelta: '{}' }
    ])
    expect(res.content).toEqual([
      { type: 'reasoning', text: 'visible', signature: 'sig-A' },
      { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
      { type: 'tool_use', id: 't1', name: 'f', input: {} }
    ])
  })

  it('keeps a signed block with no text (omitted display) between tool calls', () => {
    const res = build([
      { type: 'metadata', data: { reasoningBlock: { signature: 'sig-A' } } },
      { type: 'tool_call_delta', index: 0, id: 't1', name: 'f', argsDelta: '{}' },
      { type: 'metadata', data: { reasoningBlock: { signature: 'sig-B' } } },
      { type: 'tool_call_delta', index: 1, id: 't2', name: 'f', argsDelta: '{}' }
    ])
    expect(res.content.map((p) => (p.type === 'reasoning' ? p.signature : p.type))).toEqual(['sig-A', 'tool_use', 'sig-B', 'tool_use'])
  })

  it('orders explicit tool_call events by arrival and prefers them over same-id drafts', () => {
    const res = build([
      { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argsDelta: '{"partial":' },
      { type: 'text_delta', text: 'between' },
      { type: 'tool_call', toolCall: { id: 'c1', name: 'f', input: { whole: true } } },
      { type: 'tool_call', toolCall: { id: 'c2', name: 'g', input: {} } }
    ])
    expect(res.toolCalls.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(res.toolCalls[0]!.input).toEqual({ whole: true })
    expect(res.content.map((p) => p.type)).toEqual(['tool_use', 'text', 'tool_use'])
  })

  it('still puts unsigned reasoning, text and tool calls in their usual order', () => {
    const res = build([
      { type: 'reasoning_delta', text: 'think' },
      { type: 'text_delta', text: 'answer' },
      { type: 'tool_call', toolCall: { id: 'c1', name: 'f', input: {} } }
    ])
    expect(res.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool_use'])
    expect(res.content[0]).toEqual({ type: 'reasoning', text: 'think' })
  })
})
