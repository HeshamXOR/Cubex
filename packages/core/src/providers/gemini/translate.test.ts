import { describe, expect, it } from 'vitest'
import { assistantMessage, imagePart, textPart, userMessage } from '../../builders'
import type { JSONSchema } from '../../types/common'
import type { AIMessage } from '../../types/message'
import type { AIRequest } from '../../types/request'
import type { ToolChoice } from '../../types/tools'
import { GEMINI_SKIP_SIGNATURE, packGeminiSignature as sig } from './replay'
import { toGeminiRequest, type GemToolConfig } from './translate'

const request = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  model: 'gemini-2.5-flash',
  messages: [userMessage('hi')],
  ...overrides
})

const CALL_A = 'gemini_call_aaaaaaaaaaaaaaaa'
const CALL_B = 'gemini_call_bbbbbbbbbbbbbbbb'

const modelCalls = (...parts: AIMessage['content']): AIMessage => ({ role: 'assistant', content: parts })
const call = (id: string, name: string, input: unknown = {}): AIMessage['content'][number] => ({
  type: 'tool_use',
  id,
  name,
  input: input as never
})
const result = (id: string, text: string, isError?: boolean): AIMessage['content'][number] => ({
  type: 'tool_result',
  toolUseId: id,
  content: [textPart(text)],
  ...(isError ? { isError } : {})
})
const toolTurn = (...parts: AIMessage['content']): AIMessage => ({ role: 'tool', content: parts })

describe('toGeminiRequest: messages', () => {
  it('maps roles to user and model and puts the system prompt in systemInstruction', () => {
    const body = toGeminiRequest(
      request({ system: 'You are terse.', messages: [userMessage('a'), assistantMessage('b'), userMessage('c')] })
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are terse.' }] })
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'model', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] }
    ])
  })

  it('folds system parts and system or developer messages into one instruction', () => {
    const body = toGeminiRequest(
      request({
        system: [textPart('Base rules.'), textPart('More rules.')],
        messages: [
          { role: 'developer', content: [textPart('Dev note.')] },
          userMessage('hi'),
          { role: 'system', content: [textPart('Late note.')] }
        ]
      })
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Base rules.More rules.\n\nDev note.\n\nLate note.' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('omits systemInstruction when there is no system text', () => {
    expect(toGeminiRequest(request()).systemInstruction).toBeUndefined()
    expect(toGeminiRequest(request({ system: '' })).systemInstruction).toBeUndefined()
  })

  it('merges consecutive messages of one role (the API wants alternating turns)', () => {
    const body = toGeminiRequest(request({ messages: [userMessage('one'), userMessage('two'), assistantMessage('x')] }))
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'one' }, { text: 'two' }] },
      { role: 'model', parts: [{ text: 'x' }] }
    ])
  })

  it('drops a turn that translates to nothing instead of sending empty parts', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage('a'),
          modelCalls({ type: 'reasoning', text: 'a plain summary' }, textPart('')),
          userMessage('b')
        ]
      })
    )
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }])
  })

  it('sends only the text of an uploaded text file, not its provenance', () => {
    const part = { ...textPart('file body'), attachment: { kind: 'text_file' as const, filename: 'a.txt', mediaType: 'text/plain', sizeBytes: 9 } }
    const body = toGeminiRequest(request({ messages: [userMessage([part])] }))
    expect(body.contents[0]!.parts).toEqual([{ text: 'file body' }])
  })
})

describe('toGeminiRequest: media', () => {
  it('sends base64 images and files as inlineData', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage([
            imagePart('image/png', 'AAAA'),
            { type: 'file', source: { kind: 'base64', mediaType: 'text/plain', data: 'aGk=' }, filename: 'n.txt' },
            { type: 'file', source: { kind: 'base64', mediaType: 'application/octet-stream', data: 'AQI=' }, mediaType: 'application/pdf' },
            { type: 'audio', source: { kind: 'base64', mediaType: 'audio/mp3', data: 'BB==' }, mediaType: 'audio/mp3' },
            { type: 'video', source: { kind: 'base64', mediaType: 'video/mp4', data: 'CC==' }, mediaType: 'video/mp4' }
          ])
        ]
      })
    )
    expect(body.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { inlineData: { mimeType: 'text/plain', data: 'aGk=' } },
      { inlineData: { mimeType: 'application/pdf', data: 'AQI=' } },
      { inlineData: { mimeType: 'audio/mp3', data: 'BB==' } },
      { inlineData: { mimeType: 'video/mp4', data: 'CC==' } }
    ])
  })

  it('sends URL and file-id sources as fileData, inferring an image type from the extension', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage([
            { type: 'image', source: { kind: 'url', url: 'https://example.com/a.jpg?x=1' } },
            { type: 'image', source: { kind: 'url', url: 'https://example.com/blob' } },
            { type: 'file', source: { kind: 'file_id', id: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mediaType: 'application/pdf' } }
          ])
        ]
      })
    )
    expect(body.contents[0]!.parts).toEqual([
      { fileData: { fileUri: 'https://example.com/a.jpg?x=1', mimeType: 'image/jpeg' } },
      { fileData: { fileUri: 'https://example.com/blob' } },
      { fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'application/pdf' } }
    ])
  })
})

describe('toGeminiRequest: tools', () => {
  const schema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: { path: { type: 'string' as const, description: 'File path' }, depth: { type: ['integer', 'null'] } },
    required: ['path']
  } as unknown as JSONSchema

  it('declares tools as functionDeclarations with a sanitized schema', () => {
    const body = toGeminiRequest(request({ tools: [{ name: 'read_file', description: 'Read a file', inputSchema: schema }] }))
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', description: 'File path' }, depth: { type: 'integer', nullable: true } },
              required: ['path']
            }
          }
        ]
      }
    ])
  })

  it('omits parameters for a tool that takes none and describes a nameless one by its name', () => {
    const body = toGeminiRequest(request({ tools: [{ name: 'list_tools', inputSchema: { type: 'object', properties: {} } }] }))
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'list_tools', description: 'list_tools' }] }])
  })

  it('declares a name only once (the API rejects duplicates)', () => {
    const tool = { name: 'dup', description: 'd', inputSchema: { type: 'object' as const, properties: {} } }
    const decls = toGeminiRequest(request({ tools: [tool, tool, { ...tool, name: 'other' }] })).tools![0]!.functionDeclarations
    expect(decls.map((d) => d.name)).toEqual(['dup', 'other'])
  })

  it.each<[ToolChoice, GemToolConfig]>([
    ['auto', { functionCallingConfig: { mode: 'AUTO' } }],
    ['none', { functionCallingConfig: { mode: 'NONE' } }],
    ['required', { functionCallingConfig: { mode: 'ANY' } }],
    [{ type: 'tool' as const, name: 'read_file' }, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } }]
  ])('maps toolChoice %j', (toolChoice, toolConfig) => {
    const body = toGeminiRequest(request({ toolChoice, tools: [{ name: 'read_file', inputSchema: schema }] }))
    expect(body.toolConfig).toEqual(toolConfig)
  })

  it('sends no toolConfig without tools, and none for the default choice', () => {
    expect(toGeminiRequest(request({ toolChoice: 'required' })).toolConfig).toBeUndefined()
    expect(toGeminiRequest(request({ tools: [{ name: 't', inputSchema: schema }] })).toolConfig).toBeUndefined()
  })
})

describe('toGeminiRequest: generation config', () => {
  it('maps sampling parameters', () => {
    const body = toGeminiRequest(
      request({
        model: 'gemini-2.0-flash',
        params: { temperature: 0.2, topP: 0.9, topK: 40, maxOutputTokens: 512, stopSequences: ['a', 'b', 'c', 'd', 'e', 'f'], seed: 7, presencePenalty: 0.1, frequencyPenalty: 0.2 }
      })
    )
    expect(body.generationConfig).toEqual({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 512,
      stopSequences: ['a', 'b', 'c', 'd', 'e'],
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2
    })
  })

  it('omits generationConfig for a non-thinking model with no parameters', () => {
    expect(toGeminiRequest(request({ model: 'gemini-2.0-flash' })).generationConfig).toBeUndefined()
  })

  it('always asks a thinking model for thought summaries, and passes the depth for its family', () => {
    expect(toGeminiRequest(request({ model: 'gemini-2.5-pro' })).generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } })
    expect(toGeminiRequest(request({ model: 'gemini-2.5-flash', params: { reasoningEffort: 'medium' } })).generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 }
    })
    expect(toGeminiRequest(request({ model: 'gemini-3-flash-preview', params: { reasoningEffort: 'low' } })).generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' }
    })
  })

  it('lets model metadata decide that an unfamiliar model thinks', () => {
    expect(toGeminiRequest(request({ model: 'my-tuned-model' })).generationConfig).toBeUndefined()
    expect(toGeminiRequest(request({ model: 'my-tuned-model' }), { supportsThinking: true }).generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true }
    })
  })

  it('maps json_object and json_schema response formats', () => {
    expect(toGeminiRequest(request({ model: 'gemini-2.0-flash', responseFormat: { type: 'json_object' } })).generationConfig).toEqual({
      responseMimeType: 'application/json'
    })
    const body = toGeminiRequest(
      request({
        model: 'gemini-2.0-flash',
        responseFormat: {
          type: 'json_schema',
          name: 'out',
          schema: { type: 'object', additionalProperties: false, properties: { n: { type: ['integer', 'null'] } }, required: ['n'] } as unknown as JSONSchema
        }
      })
    )
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { n: { type: 'integer', nullable: true } }, required: ['n'] }
    })
  })
})

describe('toGeminiRequest: function calls', () => {
  it('replays calls and results as functionCall and functionResponse, parallel calls in order', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage('compare the files'),
          modelCalls(
            { type: 'reasoning', text: 'Plan: read both.' },
            call(CALL_A, 'read_file', { path: 'a.ts' }),
            { type: 'reasoning', text: '', signature: sig('SIG-A') },
            call(CALL_B, 'read_file', { path: 'b.ts' })
          ),
          toolTurn(result(CALL_A, 'A body'), result(CALL_B, 'B body'))
        ]
      })
    )
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'compare the files' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'SIG-A' },
          { functionCall: { name: 'read_file', args: { path: 'b.ts' } } }
        ]
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { output: 'A body' } } },
          { functionResponse: { name: 'read_file', response: { output: 'B body' } } }
        ]
      }
    ])
  })

  it('echoes an id the API issued on both the call and its response, and no synthesized id', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage('go'),
          modelCalls(call('gemini_id_xyz', 'a'), call(CALL_B, 'b')),
          toolTurn(result('gemini_id_xyz', 'ra'), result(CALL_B, 'rb'))
        ]
      })
    )
    expect(body.contents[1]!.parts).toEqual([
      { functionCall: { id: 'xyz', name: 'a', args: {} } },
      { functionCall: { name: 'b', args: {} } }
    ])
    expect(body.contents[2]!.parts).toEqual([
      { functionResponse: { id: 'xyz', name: 'a', response: { output: 'ra' } } },
      { functionResponse: { name: 'b', response: { output: 'rb' } } }
    ])
  })

  it('reports a failed tool as an error response', () => {
    const body = toGeminiRequest(
      request({ messages: [userMessage('go'), modelCalls(call(CALL_A, 'run')), toolTurn(result(CALL_A, 'exit 1', true))] })
    )
    expect(body.contents[2]!.parts).toEqual([{ functionResponse: { name: 'run', response: { error: 'exit 1' } } }])
  })

  it('answers calls in the order they were made even if results arrive in another order', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage('go'),
          modelCalls(call(CALL_A, 'a'), call(CALL_B, 'b')),
          toolTurn(result(CALL_B, 'rb'), result(CALL_A, 'ra'))
        ]
      })
    )
    expect(body.contents[2]!.parts!.map((p) => p.functionResponse?.name)).toEqual(['a', 'b'])
  })

  it('invents an error response for a call that never got a result (a 400 otherwise)', () => {
    const body = toGeminiRequest(
      request({
        messages: [userMessage('go'), modelCalls(call(CALL_A, 'a'), call(CALL_B, 'b')), toolTurn(result(CALL_A, 'ra'))]
      })
    )
    expect(body.contents[2]!.parts).toEqual([
      { functionResponse: { name: 'a', response: { output: 'ra' } } },
      { functionResponse: { name: 'b', response: { error: 'No result was recorded for this tool call.' } } }
    ])
  })

  it('turns a result with no matching call into plain text instead of an invalid response', () => {
    const body = toGeminiRequest(request({ messages: [userMessage('go'), toolTurn(result('unknown-id', 'orphan'))] }))
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'go' }, { text: 'Result of an earlier tool call:\norphan' }] }])
  })

  it('sends images a tool returned after the function responses', () => {
    const body = toGeminiRequest(
      request({
        messages: [
          userMessage('shot'),
          modelCalls(call(CALL_A, 'screenshot')),
          toolTurn({ type: 'tool_result', toolUseId: CALL_A, content: [textPart('captured'), imagePart('image/png', 'PNG=')] })
        ]
      })
    )
    expect(body.contents[2]!.parts).toEqual([
      { functionResponse: { name: 'screenshot', response: { output: 'captured' } } },
      { inlineData: { mimeType: 'image/png', data: 'PNG=' } }
    ])
  })

  it('keeps a call whose input is not an object valid', () => {
    const body = toGeminiRequest(
      request({ messages: [userMessage('go'), modelCalls(call(CALL_A, 'a', 'raw'), call(CALL_B, 'b', null)), toolTurn(result(CALL_A, 'x'), result(CALL_B, 'y'))] })
    )
    expect(body.contents[1]!.parts!.map((p) => p.functionCall?.args)).toEqual([{ value: 'raw' }, {}])
  })
})

describe('toGeminiRequest: thought signatures', () => {
  const callTurn = (...parts: AIMessage['content']): AIRequest =>
    request({ messages: [userMessage('go'), modelCalls(...parts), toolTurn(result(CALL_A, 'r'))] })

  it('replays a signed thought summary with its signature', () => {
    const body = toGeminiRequest(callTurn({ type: 'reasoning', text: 'Thinking about it.', signature: sig('S1') }, call(CALL_A, 'a')))
    expect(body.contents[1]!.parts).toEqual([
      { text: 'Thinking about it.', thought: true, thoughtSignature: 'S1' },
      { functionCall: { name: 'a', args: {} } }
    ])
  })

  it('puts a signature that follows text on that text', () => {
    const body = toGeminiRequest(
      request({ messages: [userMessage('q'), modelCalls(textPart('Answer.'), { type: 'reasoning', text: '', signature: sig('S2') }), userMessage('more')] })
    )
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Answer.', thoughtSignature: 'S2' }] })
  })

  it('keeps a signature that has nothing to follow on an empty part', () => {
    const body = toGeminiRequest(
      request({ messages: [userMessage('q'), modelCalls({ type: 'reasoning', text: '', signature: sig('S3') }), userMessage('more')] })
    )
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: '', thoughtSignature: 'S3' }] })
  })

  it('never sends another provider\'s signature or redacted reasoning to Gemini', () => {
    const body = toGeminiRequest(
      callTurn(
        { type: 'reasoning', text: 'x', signature: 'EqoBCkgIBRAB-anthropic' },
        { type: 'reasoning', text: '', redacted: 'ENCRYPTED' },
        call(CALL_A, 'a'),
        { type: 'reasoning', text: '', signature: 'anthropic-after-call' }
      )
    )
    expect(body.contents[1]!.parts).toEqual([{ functionCall: { name: 'a', args: {} } }])
  })

  it('does not stack a second signature on a part that already has one', () => {
    const body = toGeminiRequest(
      callTurn(
        call(CALL_A, 'a'),
        { type: 'reasoning', text: '', signature: sig('FIRST') },
        { type: 'reasoning', text: '', signature: sig('SECOND') }
      )
    )
    expect(body.contents[1]!.parts).toEqual([
      { functionCall: { name: 'a', args: {} }, thoughtSignature: 'FIRST' },
      { text: '', thoughtSignature: 'SECOND' }
    ])
  })
})

describe('toGeminiRequest: Gemini 3 signature validation', () => {
  const g3 = (messages: AIMessage[], model = 'gemini-3-flash-preview'): AIRequest => request({ model, messages })

  it('marks the first unsigned call of a step in the current turn so the API skips the check', () => {
    const body = toGeminiRequest(
      g3([userMessage('go'), modelCalls(call(CALL_A, 'a'), call(CALL_B, 'b')), toolTurn(result(CALL_A, 'x'), result(CALL_B, 'y'))])
    )
    expect(body.contents[1]!.parts).toEqual([
      { functionCall: { name: 'a', args: {} }, thoughtSignature: GEMINI_SKIP_SIGNATURE },
      { functionCall: { name: 'b', args: {} } }
    ])
  })

  it('leaves a genuine signature alone', () => {
    const body = toGeminiRequest(
      g3([userMessage('go'), modelCalls(call(CALL_A, 'a'), { type: 'reasoning', text: '', signature: sig('REAL') }), toolTurn(result(CALL_A, 'x'))])
    )
    expect(body.contents[1]!.parts![0]!.thoughtSignature).toBe('REAL')
  })

  it('does not touch earlier turns, which the API does not validate', () => {
    const body = toGeminiRequest(
      g3([
        userMessage('first'),
        modelCalls(call(CALL_A, 'a')),
        toolTurn(result(CALL_A, 'x')),
        assistantMessage('done'),
        userMessage('second'),
        modelCalls(call(CALL_B, 'b')),
        toolTurn(result(CALL_B, 'y'))
      ])
    )
    const signatures = body.contents.flatMap((c) => c.parts).flatMap((p) => p.thoughtSignature ?? [])
    expect(signatures).toEqual([GEMINI_SKIP_SIGNATURE])
    expect(body.contents[1]!.parts![0]!.thoughtSignature).toBeUndefined()
  })

  it('does not add it for Gemini 2.5, where signatures are optional', () => {
    const body = toGeminiRequest(
      g3([userMessage('go'), modelCalls(call(CALL_A, 'a')), toolTurn(result(CALL_A, 'x'))], 'gemini-2.5-flash')
    )
    expect(body.contents[1]!.parts![0]!.thoughtSignature).toBeUndefined()
  })
})

describe('toGeminiRequest: Gemma', () => {
  it('folds the system prompt into the first user turn (Gemma has no systemInstruction)', () => {
    const body = toGeminiRequest(request({ model: 'gemma-3-27b-it', system: 'Be brief.', messages: [userMessage('hi')] }))
    expect(body.systemInstruction).toBeUndefined()
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Be brief.' }, { text: 'hi' }] }])
  })
})
