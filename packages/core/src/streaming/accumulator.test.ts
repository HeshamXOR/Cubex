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
