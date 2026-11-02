import { describe, expect, it } from 'vitest'
import { parseToolArguments, toolInputFromArguments } from './toolArguments'
import { StreamAccumulator } from './accumulator'

describe('parseToolArguments', () => {
  const read = (raw: string, complete = true): unknown => toolInputFromArguments(raw, { complete })

  it.each([
    ['empty text is no arguments', '', {}],
    ['null is no arguments', 'null', {}],
    ['a json code fence', '```json\n{"path": "a.ts"}\n```', { path: 'a.ts' }],
    ['a fence with no closing line', '```\n{"path": "a.ts"}', { path: 'a.ts' }],
    ['a trailing comma', '{"paths": ["a", "b",], "n": 2,}', { paths: ['a', 'b'], n: 2 }],
    ['single quotes around the object', `'{"path": "a.ts"}'`, { path: 'a.ts' }],
    ['arguments encoded twice', JSON.stringify('{"path": "a.ts", "n": 1}'), { path: 'a.ts', n: 1 }],
    ['python literals', '{"recursive": True, "limit": None, "all": False}', { recursive: true, limit: null, all: false }],
    ['python dict with single quotes', "{'path': 'it\\'s.ts', 'note': 'say \"hi\"'}", { path: "it's.ts", note: 'say "hi"' }],
    ['unquoted keys', '{path: "a.ts"}', { path: 'a.ts' }],
    ['a raw newline and tab inside a string', '{"content": "line1\nline2\tend"}', { content: 'line1\nline2\tend' }],
    ['an empty object sent before the real one', '{}{"path": "a.ts"}', { path: 'a.ts' }],
    ['a missing final brace after a finished reply', '{"path": "a.ts", "opts": {"deep": true}', { path: 'a.ts', opts: { deep: true } }],
    ['a missing bracket and brace after a finished reply', '{"paths": ["a", "b"', { paths: ['a', 'b'] }]
  ])('reads %s', (_name, raw, expected) => {
    expect(read(raw)).toEqual(expected)
  })

  it('keeps a valid argument string exactly as sent', () => {
    expect(read('{"python": "True and None", "x": "a,}"}')).toEqual({ python: 'True and None', x: 'a,}' })
  })

  it('does not supply a missing brace when the reply was cut off by the output limit', () => {
    expect(read('{"path": "a.ts"', false)).toEqual({ _raw: '{"path": "a.ts"' })
    const result = parseToolArguments('{"path": "a.ts"', { complete: false })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.problem).toMatch(/before 1 open bracket/)
  })
})

describe('StreamAccumulator with sloppy tool arguments', () => {
  const finish = (args: string[], stopReason: 'tool_use' | 'length'): unknown => {
    const acc = new StreamAccumulator('nim', 'llama')
    acc.push({ type: 'tool_call_delta', index: 0, id: 'c1', name: 'write_file' })
    for (const argsDelta of args) acc.push({ type: 'tool_call_delta', index: 0, argsDelta })
    acc.push({ type: 'stop', stopReason })
    return acc.finalize().toolCalls[0]!.input
  }

  it('leaves the call unparsed when the reply stopped at the output limit', () => {
    expect(finish(['{"path": "a.txt", "content": "hi"'], 'length')).toEqual({ _raw: '{"path": "a.txt", "content": "hi"' })
  })
})
