import { describe, expect, it } from 'vitest'
import type { JSONSchema, JSONValue, ToolCall } from '@core/types'
import { repairToolCall, type RepairableTool } from './toolCallRepair'

const tools: RepairableTool[] = [
  { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'list_files', inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } } },
  { name: 'write_file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_command', inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' }, background: { type: 'boolean' } }, required: ['command'] } },
  { name: 'open_urls', inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['text', 'raw'] } }, required: ['urls'] } },
  { name: 'strict_tool', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
  {
    name: 'edit_file',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } } },
      required: ['file_path', 'edits']
    }
  }
]

const call = (name: string, input: unknown): ToolCall => ({ id: 'c1', name, input: input as JSONValue })
const repaired = (c: ToolCall): { call: ToolCall; repairs: string[] } => {
  const result = repairToolCall(c, tools)
  if ('error' in result) throw new Error(result.error)
  return result
}
const failed = (c: ToolCall): string => {
  const result = repairToolCall(c, tools)
  if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result.call)}`)
  return result.error
}

describe('repairToolCall: tool names', () => {
  it('returns a valid call untouched', () => {
    const valid = call('read_file', { path: 'a.ts', start_line: 3 })
    const result = repaired(valid)
    expect(result.call).toBe(valid)
    expect(result.repairs).toEqual([])
  })

  it.each([
    ['Read-File', 'read_file'],
    ['READ_FILE', 'read_file'],
    ['functions.read_file', 'read_file'],
    ['functions.read_file:0', 'read_file'],
    ['default_api:read_file', 'read_file'],
    ['tools/Read_File', 'read_file'],
    ['fs_read', 'read_file'],
    ['cat', 'read_file']
  ])('maps %s onto %s', (given, expected) => {
    const result = repaired(call(given, { path: 'src/a.ts' }))
    expect(result.call).toMatchObject({ id: 'c1', name: expected, input: { path: 'src/a.ts' } })
    expect(result.repairs[0]).toContain(given)
  })

  it('renames the arguments of a foreign alias the same way text-emitted calls are mapped', () => {
    expect(repaired(call('fs_write', { file: 'a.txt', text: 'hi' })).call).toMatchObject({ name: 'write_file', input: { path: 'a.txt', content: 'hi' } })
  })

  it('does not make up an argument the alias mapping would default to empty', () => {
    expect(failed(call('fs_write', { file: 'a.txt' }))).toMatch(/"content" is required but missing/)
  })

  it('suggests the nearest tool and lists the available ones for an unknown name', () => {
    const message = failed(call('read_fil', {}))
    expect(message).toContain('no tool named "read_fil"')
    expect(message).toContain('Did you mean "read_file"?')
    expect(message).toContain('list_files')
  })

  it('does not guess at a foreign name that matches nothing', () => {
    expect(failed(call('execute_bash', { command: 'ls' }))).toContain('no tool named "execute_bash"')
  })
})

describe('repairToolCall: input shape', () => {
  it.each([
    ['numbers and booleans sent as strings', 'run_command', { command: 'ls', timeout_ms: '5000', background: 'False' }, { command: 'ls', timeout_ms: 5000, background: false }],
    ['an integer sent as a float-looking string', 'read_file', { path: 'a.ts', start_line: '10.0' }, { path: 'a.ts', start_line: 10 }],
    ['a number where a string is wanted', 'run_command', { command: 123 }, { command: '123' }],
    ['one string where a list is wanted', 'open_urls', { urls: 'https://a.dev' }, { urls: ['https://a.dev'] }],
    ['a list sent as a JSON string', 'open_urls', { urls: '["https://a.dev", "https://b.dev"]' }, { urls: ['https://a.dev', 'https://b.dev'] }],
    ['an enum in the wrong case', 'open_urls', { urls: ['x'], mode: 'RAW' }, { urls: ['x'], mode: 'raw' }],
    ['null for optional properties', 'read_file', { path: 'a.ts', start_line: null, end_line: null }, { path: 'a.ts' }],
    ['a property spelled filePath for file_path', 'edit_file', { filePath: 'a.ts', edits: [{ old: 'a', new: 'b' }] }, { file_path: 'a.ts', edits: [{ old: 'a', new: 'b' }] }],
    ['nested objects in a string', 'edit_file', { file_path: 'a.ts', edits: '[{"old": "a", "new": "b"}]' }, { file_path: 'a.ts', edits: [{ old: 'a', new: 'b' }] }],
    ['an extra input wrapper', 'read_file', { input: { path: 'a.ts' } }, { path: 'a.ts' }],
    ['arguments nested as a JSON string', 'read_file', { arguments: '{"path": "a.ts"}' }, { path: 'a.ts' }],
    ['a lone positional string', 'read_file', 'src/a.ts', { path: 'src/a.ts' }],
    ['arguments left as fenced text', 'read_file', '```json\n{"path": "a.ts",}\n```', { path: 'a.ts' }]
  ])('fixes %s', (_name, tool, input, expected) => {
    const result = repaired(call(tool, input))
    expect(result.call.input).toEqual(expected)
    expect(result.repairs.length).toBeGreaterThan(0)
  })

  it('drops unknown properties only where the schema forbids them', () => {
    expect(repaired(call('strict_tool', { a: 'x', extra: 1 })).call.input).toEqual({ a: 'x' })
    const open = call('read_file', { path: 'a.ts', note: 'keep me' })
    expect(repaired(open).call).toBe(open)
  })

  it('does not unwrap a property the tool really has', () => {
    const withInput: RepairableTool = { name: 'echo', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }
    const c = call('echo', { input: 'hello' })
    expect(repairToolCall(c, [withInput])).toEqual({ call: c, repairs: [] })
  })

  it('treats empty arguments as {} for a tool with no required properties', () => {
    expect(repaired(call('list_files', '')).call.input).toEqual({})
  })
})

describe('repairToolCall: errors written for the model', () => {
  it('names the tool, the missing property, the shape and an example', () => {
    const message = failed(call('write_file', { path: 'a.txt' }))
    expect(message).toContain('"write_file" call was not run')
    expect(message).toContain('"content" is required but missing')
    expect(message).toContain('{ "path": string (required), "content": string (required) }')
    expect(message).toContain('Example: {"path":"<path>","content":"<content>"}')
  })

  it('says what is wrong with a value that cannot be coerced', () => {
    const message = failed(call('run_command', { command: 'ls', timeout_ms: 'soon' }))
    expect(message).toContain('"timeout_ms" must be a number, got the string "soon"')
    expect(message).toContain('"command": string (required)')
  })

  it('reports an enum with the allowed values', () => {
    expect(failed(call('open_urls', { urls: ['x'], mode: 'pdf' }))).toContain('"mode" must be one of "text", "raw"')
  })

  it('points into a nested value', () => {
    expect(failed(call('edit_file', { file_path: 'a.ts', edits: [{ old: 'a' }] }))).toContain('"edits[0].new" is required but missing')
  })

  it('explains arguments the stream could not parse, with the start of what arrived', () => {
    const message = failed(call('write_file', { _raw: '{"path": "a.txt", "content": "unfinished' }))
    expect(message).toContain('"write_file" call was not run')
    expect(message).toMatch(/not valid JSON.*unfinished string/)
    expect(message).toContain('{\\"path\\": \\"a.txt\\"')
  })

  it('rejects a bare value for a tool that takes several required properties', () => {
    expect(failed(call('write_file', 'hello'))).toContain('instead of a JSON object')
  })
})

describe('repairToolCall: schemas it does not read', () => {
  it('leaves union-typed properties alone', () => {
    const schema: JSONSchema = { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['value'] }
    const c = call('set', { value: 5 })
    expect(repairToolCall(c, [{ name: 'set', inputSchema: schema }])).toEqual({ call: c, repairs: [] })
  })
})
