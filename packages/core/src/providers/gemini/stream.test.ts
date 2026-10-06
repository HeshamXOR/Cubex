import { describe, expect, it } from 'vitest'
import { assistantTurn, textPart, userMessage } from '../../builders'
import { StreamAccumulator } from '../../streaming/accumulator'
import { NormalizedAIError } from '../../types/errors'
import type { AIStreamEvent } from '../../types/stream'
import { fixtureFrames } from './testSupport'
import { geminiCallId, packGeminiSignature } from './replay'
import { GeminiStreamMapper, mapGeminiFinishReason, mapGeminiUsage, type GemChunk } from './stream'
import { toGeminiRequest } from './translate'

const MODEL = 'gemini-3-flash-preview'

function run(fixture: string, model = MODEL): AIStreamEvent[] {
  const mapper = new GeminiStreamMapper('gem', model)
  const events: AIStreamEvent[] = []
  for (const frame of fixtureFrames(fixture)) events.push(...mapper.push(frame as GemChunk))
  events.push(...mapper.end())
  return events
}

function failure(fixture: string): { error: NormalizedAIError; before: AIStreamEvent[] } {
  const mapper = new GeminiStreamMapper('gem', MODEL)
  const before: AIStreamEvent[] = []
  try {
    for (const frame of fixtureFrames(fixture)) before.push(...mapper.push(frame as GemChunk))
    before.push(...mapper.end())
  } catch (error) {
    expect(error).toBeInstanceOf(NormalizedAIError)
    return { error: error as NormalizedAIError, before }
  }
  throw new Error(`${fixture} did not fail`)
}

const SIGNATURE = 'CiQBjz1rXx0y8Qk3m9v5Lw4t2nPq7cRZaBsE1uYhGdKoWfTj6Ng='

describe('GeminiStreamMapper: text', () => {
  it('streams text deltas, then the stop reason and the final usage', () => {
    expect(run('plain-text', 'gemini-2.5-flash')).toEqual([
      { type: 'start', provider: 'gem', model: 'gemini-2.5-flash', requestId: 'Zr5CaOrjFMy1z7IPq-qyuQw' },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' there! How can I' },
      { type: 'text_delta', text: ' help you today?' },
      { type: 'stop', stopReason: 'stop' },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 11, totalTokens: 19 } }
    ])
  })

  it('builds the full response through the accumulator', () => {
    const acc = new StreamAccumulator('gem', 'gemini-2.5-flash')
    for (const event of run('plain-text', 'gemini-2.5-flash')) acc.push(event)
    const response = acc.finalize()
    expect(response.text).toBe('Hello there! How can I help you today?')
    expect(response.stopReason).toBe('stop')
    expect(response.usage).toEqual({ inputTokens: 8, outputTokens: 11, totalTokens: 19 })
    expect(response.requestId).toBe('Zr5CaOrjFMy1z7IPq-qyuQw')
  })

  it('reads usage from a trailing usage-only chunk, with cached and thought tokens', () => {
    const events = run('usage-chunk', 'gemini-2.5-pro')
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'Cached answer.' }])
    expect(events.at(-1)).toEqual({
      type: 'usage',
      usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 50, reasoningTokens: 30, totalTokens: 1250 }
    })
  })
})

describe('GeminiStreamMapper: thinking and function calls', () => {
  it('maps thought summaries to reasoning, the call to a tool_call and carries its signature', () => {
    const id = geminiCallId({ name: 'read_file', args: { path: 'src/index.ts' } }, 0, 'Q75CaMvbKN-Vz7IPw4S-8AM')
    expect(run('thinking-function-call')).toEqual([
      { type: 'start', provider: 'gem', model: MODEL, requestId: 'Q75CaMvbKN-Vz7IPw4S-8AM' },
      { type: 'reasoning_delta', text: '**Reading the entry point**\n\nI need to look at the file before I can answer.' },
      { type: 'reasoning_delta', text: ' I will call read_file on src/index.ts.' },
      { type: 'tool_call', toolCall: { id, name: 'read_file', input: { path: 'src/index.ts' } } },
      { type: 'metadata', data: { reasoningBlock: { signature: packGeminiSignature(SIGNATURE) } } },
      { type: 'stop', stopReason: 'tool_use' },
      { type: 'usage', usage: { inputTokens: 62, outputTokens: 78, reasoningTokens: 61, totalTokens: 140 } }
    ])
  })

  it('keeps the signature with its call all the way back into the next request', () => {
    const acc = new StreamAccumulator('gem', MODEL)
    for (const event of run('thinking-function-call')) acc.push(event)
    const response = acc.finalize()
    expect(response.stopReason).toBe('tool_use')
    expect(response.toolCalls).toHaveLength(1)

    const call = response.toolCalls[0]!
    const body = toGeminiRequest({
      model: MODEL,
      messages: [
        userMessage('what does the entry point do?'),
        assistantTurn(response),
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: call.id, content: [textPart('export {}')] }] }
      ]
    })
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'what does the entry point do?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/index.ts' } }, thoughtSignature: SIGNATURE }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'export {}' } } }] }
    ])
  })

  it('emits parallel calls with distinct ids and the signature on the first only', () => {
    const events = run('parallel-calls')
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.toolCall] : []))
    expect(calls.map((c) => c.input)).toEqual([{ path: 'a.ts' }, { path: 'b.ts' }])
    expect(new Set(calls.map((c) => c.id)).size).toBe(2)
    const order = events.map((e) => (e.type === 'metadata' ? 'signature' : e.type))
    expect(order).toEqual(['start', 'reasoning_delta', 'tool_call', 'signature', 'tool_call', 'stop', 'usage'])
  })

  it('replays parallel calls as one model turn answered by one user turn, in order', () => {
    const acc = new StreamAccumulator('gem', MODEL)
    for (const event of run('parallel-calls')) acc.push(event)
    const response = acc.finalize()
    const [first, second] = response.toolCalls
    const body = toGeminiRequest({
      model: MODEL,
      messages: [
        userMessage('compare a.ts and b.ts'),
        assistantTurn(response),
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolUseId: first!.id, content: [textPart('A')] },
            { type: 'tool_result', toolUseId: second!.id, content: [textPart('B')] }
          ]
        }
      ]
    })
    expect(body.contents[1]!.parts).toEqual([
      { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'CiQBjz1rXyPARALLELSIGNATUREAAAAAAAAAAAAAAAAAAAAAAAA=' },
      { functionCall: { name: 'read_file', args: { path: 'b.ts' } } }
    ])
    expect(body.contents[2]!.parts).toEqual([
      { functionResponse: { name: 'read_file', response: { output: 'A' } } },
      { functionResponse: { name: 'read_file', response: { output: 'B' } } }
    ])
  })

  it('carries a signature that arrives on a trailing empty text part', () => {
    const acc = new StreamAccumulator('gem', MODEL)
    for (const event of run('signature-on-text')) acc.push(event)
    const response = acc.finalize()
    expect(response.text).toBe('The answer is 42.')
    expect(response.stopReason).toBe('stop')
    expect(response.usage).toEqual({ inputTokens: 14, outputTokens: 26, reasoningTokens: 20, totalTokens: 40 })

    const body = toGeminiRequest({ model: MODEL, messages: [userMessage('6 x 7?'), assistantTurn(response), userMessage('thanks')] })
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'The answer is 42.', thoughtSignature: 'EjQKMgG+Pvb7TEXTSIGNATUREzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }]
    })
  })

  it('ends a thinking response that ran out of tokens as length, not as an error', () => {
    const events = run('thought-max-tokens', 'gemini-2.5-pro')
    expect(events).toContainEqual({ type: 'stop', stopReason: 'length' })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { inputTokens: 20, outputTokens: 200, reasoningTokens: 200, totalTokens: 220 } })
  })

  it('ignores parts it cannot render (generated images, code execution)', () => {
    const mapper = new GeminiStreamMapper('gem', MODEL)
    const events = [
      ...mapper.push({
        candidates: [
          {
            content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { executableCode: { language: 'PYTHON', code: '1' } }, { text: 'ok' }] },
            finishReason: 'STOP'
          }
        ]
      } as GemChunk),
      ...mapper.end()
    ]
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }])
  })

  it('uses an id the API supplied for a call, so the response can echo it', () => {
    const mapper = new GeminiStreamMapper('gem', MODEL)
    const events = mapper.push({
      candidates: [{ content: { parts: [{ functionCall: { id: 'abc123', name: 'run', args: { cmd: 'ls' } } }] }, finishReason: 'STOP' }]
    } as GemChunk)
    expect(events).toContainEqual({ type: 'tool_call', toolCall: { id: 'gemini_id_abc123', name: 'run', input: { cmd: 'ls' } } })
  })
})

describe('GeminiStreamMapper: refusals and failures', () => {
  it('throws a content policy error for a blocked prompt, before any event', () => {
    const { error, before } = failure('prompt-blocked')
    expect(error.category).toBe('CONTENT_POLICY')
    expect(error.retryable).toBe(false)
    expect(error.rawCode).toBe('SAFETY')
    expect(error.message).toMatch(/harassment: high/)
    expect(before).toEqual([])
  })

  it('ends gracefully as content_filter when a response is cut by safety after some output', () => {
    const events = run('response-blocked', 'gemini-2.5-flash')
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'Sure, here is how to' }])
    expect(events).toContainEqual({ type: 'stop', stopReason: 'content_filter' })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 6, totalTokens: 17 } })
  })

  it('throws when safety stops a response that had produced nothing', () => {
    const { error } = failure('response-blocked-empty')
    expect(error.category).toBe('CONTENT_POLICY')
    expect(error.message).toMatch(/harassment: medium/)
  })

  it('throws the in-band error frame as a normalized error, after the text already sent', () => {
    const { error, before } = failure('mid-stream-error')
    expect(error.category).toBe('SERVER_ERROR')
    expect(error.retryable).toBe(true)
    expect(error.statusCode).toBe(503)
    expect(before.some((e) => e.type === 'text_delta')).toBe(true)
  })

  it('treats a finished response with no answer as a retryable failure', () => {
    const { error } = failure('empty-stop')
    expect(error.category).toBe('STREAM_ERROR')
    expect(error.retryable).toBe(true)
    expect(error.message).toMatch(/empty|without an answer/i)
  })

  it('treats a malformed function call as a retryable failure', () => {
    const { error } = failure('malformed-call')
    expect(error.category).toBe('STREAM_ERROR')
    expect(error.rawCode).toBe('MALFORMED_FUNCTION_CALL')
    expect(error.message).toMatch(/malformed/i)
  })

  it('treats a stream that ends before any finish reason as a truncated response', () => {
    const mapper = new GeminiStreamMapper('gem', MODEL)
    mapper.push({ candidates: [{ content: { parts: [{ text: 'cut off' }] } }] } as GemChunk)
    expect(() => mapper.end()).toThrow(/ended before/i)
  })

  it('treats a stream with no chunks as a failed response', () => {
    expect(() => new GeminiStreamMapper('gem', MODEL).end()).toThrow(NormalizedAIError)
  })
})

describe('mapGeminiUsage', () => {
  it('counts thoughts as output (they are billed that way) and reports them separately', () => {
    expect(
      mapGeminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 })
    ).toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 50, reasoningTokens: 30, totalTokens: 150 })
  })

  it('adds tool-use prompt tokens to the input', () => {
    expect(mapGeminiUsage({ promptTokenCount: 100, toolUsePromptTokenCount: 25 })).toEqual({ inputTokens: 125 })
  })

  it('returns nothing for no usage', () => {
    expect(mapGeminiUsage(undefined)).toBeUndefined()
    expect(mapGeminiUsage({})).toBeUndefined()
  })

  it('ignores values that are not counts', () => {
    expect(mapGeminiUsage({ promptTokenCount: -1, candidatesTokenCount: Number.NaN, totalTokenCount: 5 })).toEqual({ totalTokens: 5 })
  })
})

describe('mapGeminiFinishReason', () => {
  it.each([
    ['STOP', false, 'stop'],
    ['STOP', true, 'tool_use'],
    ['MAX_TOKENS', false, 'length'],
    ['MAX_TOKENS', true, 'length'],
    ['SAFETY', false, 'content_filter'],
    ['RECITATION', false, 'content_filter'],
    ['PROHIBITED_CONTENT', false, 'content_filter'],
    ['SPII', false, 'content_filter'],
    ['BLOCKLIST', false, 'content_filter'],
    ['MALFORMED_FUNCTION_CALL', false, 'error'],
    ['OTHER', false, 'unknown'],
    [undefined, false, 'unknown']
  ])('maps %s (tool call seen: %s) to %s', (reason, sawToolCall, expected) => {
    expect(mapGeminiFinishReason(reason, sawToolCall)).toBe(expected)
  })
})
