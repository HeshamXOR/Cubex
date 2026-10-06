import { describe, expect, it } from 'vitest'
import { ChatDialects, chatDialect, chatExtrasRejected, chatExtrasSent } from './dialect'
import { toChatCompletionsBody, toChatMessages } from './translate'
import { userMessage } from '../../builders'
import type { AIMessage } from '../../types/message'
import type { AIRequest } from '../../types/request'

const call = { type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
const toolResult: AIMessage = {
  role: 'tool',
  content: [{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] }]
}
const request = (...messages: AIMessage[]): AIRequest => ({ model: 'deepseek-v4-pro', messages })

describe('chatDialect', () => {
  it('gives OpenAI itself stream usage and metadata, and never reasoning_content', () => {
    const openai = { streamUsage: true, metadata: true, reasoningContent: false }
    expect(chatDialect(undefined, 'gpt-5.6')).toEqual(openai)
    expect(chatDialect('https://api.openai.com/v1', 'gpt-5.6')).toEqual(openai)
    // Even a model that looks like DeepSeek is never sent the extra field on OpenAI.
    expect(chatDialect('https://api.openai.com/v1', 'deepseek-v4-pro').reasoningContent).toBe(false)
  })

  it('keeps metadata to OpenAI: other servers ignore it at best and 400 at worst', () => {
    for (const base of ['https://api.deepseek.com', 'https://api.moonshot.ai/v1', 'https://example.test/v1', 'http://localhost:8000/v1']) {
      expect(chatDialect(base, 'some-model').metadata).toBe(false)
    }
  })

  it('echoes reasoning_content to the DeepSeek and Moonshot (Kimi) APIs', () => {
    for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1', 'https://api.kimi.com/coding/v1']) {
      expect(chatDialect(base, 'any-model').reasoningContent).toBe(true)
    }
  })

  it('echoes reasoning_content for DeepSeek and Kimi models served by another host', () => {
    expect(chatDialect('https://gateway.example/v1', 'deepseek-ai/DeepSeek-V3.2').reasoningContent).toBe(true)
    expect(chatDialect('http://localhost:8000/v1', 'moonshotai/Kimi-K2-Thinking').reasoningContent).toBe(true)
    expect(chatDialect('https://gateway.example/v1', 'kimi-k2.6').reasoningContent).toBe(true)
  })

  it('does not echo reasoning_content to other models on unknown hosts', () => {
    expect(chatDialect('https://gateway.example/v1', 'gpt-oss-120b').reasoningContent).toBe(false)
    expect(chatDialect('https://api.groq.com/openai/v1', 'llama-3.3-70b').reasoningContent).toBe(false)
  })

  it('asks for stream usage everywhere except hosts known to reject it', () => {
    expect(chatDialect('https://api.deepseek.com', 'x').streamUsage).toBe(true)
    expect(chatDialect('https://api.moonshot.ai/v1', 'x').streamUsage).toBe(true)
    expect(chatDialect('http://localhost:8080/v1', 'x').streamUsage).toBe(true)
    expect(chatDialect('https://api.mistral.ai/v1', 'x').streamUsage).toBe(false)
  })

  it('treats an unparsable base URL as an unknown host', () => {
    expect(chatDialect('not a url', 'x')).toEqual({ streamUsage: true, metadata: false, reasoningContent: false })
  })
})

describe('chatExtrasRejected', () => {
  const sent = ['stream_options', 'metadata', 'reasoning_content'] as const

  it('names the extra a server says it does not recognize', () => {
    expect(chatExtrasRejected(400, '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', sent)).toEqual(['stream_options'])
    expect(chatExtrasRejected(400, "Additional properties are not allowed ('metadata' was unexpected)", sent)).toEqual(['metadata'])
    expect(chatExtrasRejected(400, "messages.1: property 'reasoning_content' is unsupported", sent)).toEqual(['reasoning_content'])
    expect(chatExtrasRejected(400, 'Unknown parameter: stream_options', sent)).toEqual(['stream_options'])
    expect(chatExtrasRejected(400, 'Invalid parameter: stream_options', sent)).toEqual(['stream_options'])
  })

  it('reads a 422 the same way, and a pydantic-style body', () => {
    const body = '{"detail":[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]}'
    expect(chatExtrasRejected(422, body, sent)).toEqual(['stream_options'])
  })

  it('treats include_usage as the stream_options field', () => {
    expect(chatExtrasRejected(400, 'unknown field include_usage', sent)).toEqual(['stream_options'])
  })

  it('does not read a server asking FOR reasoning_content as a refusal of it', () => {
    expect(chatExtrasRejected(400, 'thinking is enabled but reasoning_content is missing in assistant tool call message at index 3', sent)).toEqual([])
    expect(chatExtrasRejected(400, 'The reasoning_content in the thinking mode must be passed back to the API.', sent)).toEqual([])
  })

  it('names reasoning_effort when a server does not take it', () => {
    const withEffort = [...sent, 'reasoning_effort'] as const
    expect(chatExtrasRejected(400, "Unsupported parameter: 'reasoning_effort'", withEffort)).toEqual(['reasoning_effort'])
    expect(chatExtrasRejected(400, 'Unknown parameter: reasoning.effort', withEffort)).toEqual(['reasoning_effort'])
    const body = '{"detail":[{"type":"extra_forbidden","loc":["body","reasoning_effort"],"msg":"Extra inputs are not permitted"}]}'
    expect(chatExtrasRejected(422, body, withEffort)).toEqual(['reasoning_effort'])
  })

  it('only counts extras the request actually carried', () => {
    expect(chatExtrasRejected(400, 'Unrecognized request argument supplied: metadata', ['stream_options'])).toEqual([])
  })

  it('ignores other statuses and unrelated 400s', () => {
    expect(chatExtrasRejected(500, 'Unrecognized request argument supplied: stream_options', sent)).toEqual([])
    expect(chatExtrasRejected(401, 'unknown field stream_options', sent)).toEqual([])
    expect(chatExtrasRejected(400, '{"error":{"type":"invalid_request_error","message":"max_tokens is too large"}}', sent)).toEqual([])
  })
})

describe('toChatMessages reasoning_content', () => {
  const echo = { reasoningContent: true }

  it('echoes unsigned reasoning on the assistant turn that carries tool calls', () => {
    const messages = toChatMessages(request(
      userMessage('Fix it'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Read a.ts first.' }, call] },
      toolResult
    ), echo)
    expect(messages[1]).toEqual({
      role: 'assistant',
      reasoning_content: 'Read a.ts first.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]
    })
  })

  it('joins reasoning blocks in the order they were produced', () => {
    const messages = toChatMessages(request(userMessage('go'), {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'one, ' }, { type: 'text', text: 'Reading.' }, { type: 'reasoning', text: 'two' }, call]
    }), echo)
    expect(messages[1]).toMatchObject({ content: 'Reading.', reasoning_content: 'one, two' })
  })

  it('sends an empty reasoning_content on a tool-call turn that has none, which the servers require', () => {
    // Turns written by another provider, or loaded from text-only history, carry no reasoning.
    const messages = toChatMessages(request(userMessage('go'), { role: 'assistant', content: [call] }, toolResult), echo)
    expect(messages[1]).toHaveProperty('reasoning_content', '')
  })

  it('never echoes provider-signed thinking, which belongs to the provider that wrote it', () => {
    const messages = toChatMessages(request(userMessage('go'), {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'summary of signed thinking', signature: 'sig-A' },
        { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
        call
      ]
    }), echo)
    expect(messages[1]).toHaveProperty('reasoning_content', '')
    expect(JSON.stringify(messages)).not.toContain('signed thinking')
    expect(JSON.stringify(messages)).not.toContain('ENCRYPTED')
  })

  it('leaves plain answers without the field when there was no reasoning', () => {
    const messages = toChatMessages(request(userMessage('hi'), { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }, userMessage('again')), echo)
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello.' })
  })

  it('echoes reasoning on a plain answer too, since DeepSeek takes every earlier turn back', () => {
    const messages = toChatMessages(request(userMessage('hi'), {
      role: 'assistant', content: [{ type: 'reasoning', text: 'greeting' }, { type: 'text', text: 'Hello.' }]
    }, userMessage('again')), echo)
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello.', reasoning_content: 'greeting' })
  })

  it('sends no reasoning_content unless asked: servers that reject unknown fields never see it', () => {
    const messages = toChatMessages(request(userMessage('go'), {
      role: 'assistant', content: [{ type: 'reasoning', text: 'Read a.ts first.' }, call]
    }, toolResult))
    expect(JSON.stringify(messages)).not.toContain('reasoning_content')
  })
})

describe('toChatCompletionsBody extras', () => {
  const withMetadata: AIRequest = { model: 'x', messages: [userMessage('hi')], metadata: { user_id: 'u1' } }

  it('keeps the OpenAI defaults: stream usage and metadata both sent', () => {
    const body = toChatCompletionsBody(withMetadata, { stream: true })
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.metadata).toEqual({ user_id: 'u1' })
  })

  it('leaves stream_options out when the server is not asked for usage', () => {
    const body = toChatCompletionsBody(withMetadata, { stream: true, streamUsage: false })
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('stream_options')
  })

  it('leaves metadata out when the server does not take it', () => {
    const body = toChatCompletionsBody(withMetadata, { stream: true, metadata: false })
    expect(body).not.toHaveProperty('metadata')
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('threads reasoning_content through to the messages', () => {
    const body = toChatCompletionsBody(request(userMessage('go'), {
      role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, call]
    }, toolResult), { reasoningContent: true })
    expect(body.messages[1]).toHaveProperty('reasoning_content', 'think')
  })
})

describe('reasoning_effort as a refusable extra', () => {
  const withEffort: AIRequest = { model: 'deepseek-ai/deepseek-r1', messages: [userMessage('hi')], params: { reasoningEffort: 'high' } }

  it('is sent whenever an effort was chosen, and left out once a server refused it', () => {
    expect(toChatCompletionsBody(withEffort).reasoning_effort).toBe('high')
    expect(toChatCompletionsBody(withEffort, { reasoningEffort: false })).not.toHaveProperty('reasoning_effort')
  })

  it('is reported as sent only when the body carries it', () => {
    expect(chatExtrasSent(toChatCompletionsBody(withEffort))).toContain('reasoning_effort')
    expect(chatExtrasSent(toChatCompletionsBody({ ...withEffort, params: {} }))).not.toContain('reasoning_effort')
  })

  it('is turned off for one model without touching the others', () => {
    const dialects = new ChatDialects('https://llm.example.test/v1')
    expect(dialects.for('deepseek-ai/deepseek-r1').reasoningEffort).not.toBe(false)
    dialects.refuse('deepseek-ai/deepseek-r1', ['reasoning_effort'])
    expect(dialects.for('deepseek-ai/deepseek-r1').reasoningEffort).toBe(false)
    expect(dialects.for('qwen/qwq-32b').reasoningEffort).not.toBe(false)
  })
})
