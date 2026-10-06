import { describe, expect, it } from 'vitest'
import { imagePart, textPart, userMessage } from '../../builders'
import type { JSONSchema } from '../../types/common'
import type { AIMessage } from '../../types/message'
import type { AIRequest } from '../../types/request'
import { packGeminiSignature } from './replay'
import { toGeminiRequest } from './translate'
import { GEMINI_WIRE_CONTRACT, type ContractField } from './wireContract'

/**
 * proto3 JSON takes a number for an int64 field, which the discovery document
 * types as a string, so these are allowed to be either.
 */
const INT64 = new Set(['Schema.minItems', 'Schema.maxItems', 'Schema.minLength', 'Schema.maxLength', 'Schema.minProperties', 'Schema.maxProperties'])

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every way `value` departs from the API's definition of `schema`. */
function violations(value: unknown, schema: string, path = schema): string[] {
  const fields = GEMINI_WIRE_CONTRACT[schema]
  if (!fields) return [`${path}: no contract for ${schema}`]
  if (!isObject(value)) return [`${path}: expected an object`]
  const errors: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const field = fields[key]
    if (!field) errors.push(`${path}.${key}: not a field of ${schema}`)
    else errors.push(...fieldViolations(child, field, `${schema}.${key}`, `${path}.${key}`))
  }
  return errors
}

function fieldViolations(value: unknown, field: ContractField, label: string, path: string): string[] {
  if (field.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected an array`]
    return field.ref ? value.flatMap((item, i) => violations(item, field.ref!, `${path}[${i}]`)) : []
  }
  if (field.type === 'map') {
    if (!isObject(value)) return [`${path}: expected an object`]
    return Object.entries(value).flatMap(([key, item]) => violations(item, field.ref!, `${path}.${key}`))
  }
  if (field.ref) return violations(value, field.ref, path)

  const errors: string[] = []
  const wrong = (expected: string): void => void errors.push(`${path}: expected ${expected}`)
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string' && !(typeof value === 'number' && INT64.has(label))) wrong('a string')
      break
    case 'integer':
      if (!Number.isInteger(value)) wrong('an integer')
      break
    case 'number':
      if (typeof value !== 'number') wrong('a number')
      break
    case 'boolean':
      if (typeof value !== 'boolean') wrong('a boolean')
      break
    case 'object':
      if (!isObject(value)) wrong('an object')
      break
  }
  // Enums are matched without case: the API reads "low" and "LOW" alike.
  if (field.enum && typeof value === 'string' && !field.enum.some((e) => e.toLowerCase() === value.toLowerCase())) {
    errors.push(`${path}: "${value}" is not one of ${field.enum.join(', ')}`)
  }
  return errors
}

describe('the contract checker', () => {
  it('flags an unknown field, a wrong type and an illegal enum value', () => {
    expect(violations({ generationConfig: { thinkingConfig: { thinking_budget: 1 } } }, 'GenerateContentRequest')).toEqual([
      'GenerateContentRequest.generationConfig.thinkingConfig.thinking_budget: not a field of ThinkingConfig'
    ])
    expect(violations({ generationConfig: { maxOutputTokens: '5' } }, 'GenerateContentRequest')).toHaveLength(1)
    expect(violations({ toolConfig: { functionCallingConfig: { mode: 'SOMETIMES' } } }, 'GenerateContentRequest')).toHaveLength(1)
    expect(violations({ contents: [{ role: 'user', parts: [{ txt: 'x' }] }] }, 'GenerateContentRequest')).toHaveLength(1)
  })

  it('accepts what the API documents', () => {
    expect(
      violations(
        {
          contents: [{ role: 'user', parts: [{ text: 'x' }] }],
          generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } }
        },
        'GenerateContentRequest'
      )
    ).toEqual([])
  })
})

/** Everything the adapter can write, in one conversation. */
function kitchenSink(model: string, reasoningEffort?: NonNullable<AIRequest['params']>['reasoningEffort']): AIRequest {
  const tools = [
    {
      name: 'edit_file',
      description: 'Edit a file',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, pattern: '^[^\\0]+$' },
          mode: { enum: ['replace', 'append'] },
          line: { type: ['integer', 'null'], minimum: 1, maximum: 10_000 },
          kind: { const: 'text' },
          level: { type: 'integer', enum: [1, 2, 3] },
          at: { type: 'string', format: 'date-time' },
          link: { type: 'string', format: 'uri' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5, uniqueItems: true },
          pos: { $ref: '#/$defs/Pos' },
          either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          anything: {}
        },
        required: ['path'],
        $defs: { Pos: { type: 'object', properties: { line: { type: 'integer' }, col: { type: 'integer' } }, required: ['line'] } }
      } as unknown as JSONSchema
    },
    { name: 'list_files', description: 'List files', inputSchema: { type: 'object', properties: {} } as JSONSchema },
    { name: 'no_description', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } as JSONSchema }
  ]
  const messages: AIMessage[] = [
    userMessage([
      textPart('Look at these.'),
      imagePart('image/png', 'iVBORw0KGgo='),
      { type: 'file', source: { kind: 'base64', mediaType: 'text/plain', data: 'aGk=' } },
      { type: 'file', source: { kind: 'url', url: 'https://example.com/spec.pdf' }, mediaType: 'application/pdf' },
      { type: 'file', source: { kind: 'file_id', id: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mediaType: 'application/pdf' } }
    ]),
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Summary of thought.', signature: packGeminiSignature('SIGNED-THOUGHT') },
        { type: 'text', text: 'I will edit both.' },
        { type: 'tool_use', id: 'gemini_call_aaaaaaaaaaaaaaaa', name: 'edit_file', input: { path: 'a.ts', line: 3 } },
        { type: 'reasoning', text: '', signature: packGeminiSignature('SIG-CALL') },
        { type: 'tool_use', id: 'gemini_id_api42', name: 'list_files', input: {} }
      ]
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'gemini_call_aaaaaaaaaaaaaaaa', content: [textPart('edited'), imagePart('image/png', 'AAAA')] },
        { type: 'tool_result', toolUseId: 'gemini_id_api42', content: [textPart('boom')], isError: true }
      ]
    },
    userMessage('thanks')
  ]
  return {
    model,
    system: 'You are a coding agent.',
    messages,
    tools,
    toolChoice: { type: 'tool', name: 'edit_file' },
    responseFormat: {
      type: 'json_schema',
      name: 'answer',
      schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean' }, note: { type: ['string', 'null'] } }, required: ['done'] } as unknown as JSONSchema
    },
    params: {
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 4096,
      stopSequences: ['END'],
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  }
}

describe('request bodies match the Gemini API definition', () => {
  it.each([
    ['gemini-2.5-pro', 'max'],
    ['gemini-2.5-flash', 'minimal'],
    ['gemini-2.5-flash-lite', 'medium'],
    ['gemini-3-flash-preview', 'minimal'],
    ['gemini-3.1-pro-preview', 'high'],
    ['gemini-flash-latest', 'high'],
    ['gemini-2.0-flash', undefined]
  ] as const)('%s with effort %s', (model, effort) => {
    const body = toGeminiRequest(kitchenSink(model, effort))
    expect(violations(body, 'GenerateContentRequest')).toEqual([])
  })

  it('exercises what it claims to: the sink really produces calls, responses, signatures and media', () => {
    const body = toGeminiRequest(kitchenSink('gemini-3-flash-preview', 'low'))
    const parts = body.contents.flatMap((content) => content.parts)
    expect(parts.some((p) => p.functionCall)).toBe(true)
    expect(parts.some((p) => p.functionResponse)).toBe(true)
    expect(parts.some((p) => p.thoughtSignature)).toBe(true)
    expect(parts.some((p) => p.thought)).toBe(true)
    expect(parts.some((p) => p.inlineData)).toBe(true)
    expect(parts.some((p) => p.fileData)).toBe(true)
    expect(body.tools?.[0]?.functionDeclarations).toHaveLength(3)
    expect(body.toolConfig?.functionCallingConfig.mode).toBe('ANY')
    expect(body.generationConfig?.responseSchema).toBeDefined()
    expect(body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
  })

  it('sends tool parameters that satisfy the schema definition, nested ones included', () => {
    const body = toGeminiRequest(kitchenSink('gemini-2.5-flash'))
    const edit = body.tools![0]!.functionDeclarations[0]!
    expect(edit.parameters).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: {
        mode: { type: 'string', enum: ['replace', 'append'] },
        line: { type: 'integer', nullable: true, minimum: 1, maximum: 10_000 },
        kind: { type: 'string', enum: ['text'] },
        pos: { type: 'object', required: ['line'] }
      }
    })
    expect(JSON.stringify(edit.parameters)).not.toMatch(/additionalProperties|\$schema|\$ref|\$defs|uniqueItems/)
  })
})
