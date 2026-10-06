import { describe, expect, it } from 'vitest'
import { parseMcpArguments } from './mcpArguments'

describe('parseMcpArguments', () => {
  it.each(['', ' \n\t ', '[]'])('accepts no arguments from %j', (input) => {
    expect(parseMcpArguments(input)).toEqual({ ok: true, args: [] })
  })

  it('preserves Windows paths, empty arguments, whitespace, quotes, and shell metacharacters', () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\A B\\project', '', '  ', 'a\nb\tc', '"quoted"', '$HOME; & $(whoami)']
    expect(parseMcpArguments(JSON.stringify(args))).toEqual({ ok: true, args })
  })

  it.each(['-y package', '["a",]', '["C:\\Users\\Name"]', '{', '['])('rejects malformed JSON %j', (input) => {
    expect(parseMcpArguments(input)).toMatchObject({ ok: false, error: expect.stringContaining('JSON array') })
  })

  it.each(['null', '{}', '"arg"', '1', 'true', '[null]', '[false]', '[1]', '[{}]', '[["nested"]]', '["valid", 2]'])('rejects values other than an array of strings: %s', (input) => {
    expect(parseMcpArguments(input)).toMatchObject({ ok: false, error: expect.stringContaining('only strings') })
  })

  it('rejects an escaped NUL with the argument position', () => {
    expect(parseMcpArguments('["ok", "a\\u0000b"]')).toEqual({
      ok: false,
      error: 'Argument 2 contains a null character, which cannot be passed to a process.'
    })
  })

  it('bounds argument count while accepting 64 empty arguments', () => {
    expect(parseMcpArguments(JSON.stringify(Array(64).fill('')))).toMatchObject({ ok: true })
    expect(parseMcpArguments(JSON.stringify(Array(65).fill('')))).toMatchObject({ ok: false, error: 'Use 64 arguments or fewer.' })
  })

  it('bounds each decoded argument, including escaped JSON content', () => {
    expect(parseMcpArguments(JSON.stringify(['a'.repeat(8_192)]))).toMatchObject({ ok: true })
    expect(parseMcpArguments(JSON.stringify(['ok', 'a'.repeat(8_193)]))).toMatchObject({ ok: false, error: 'Argument 2 must be 8,192 characters or fewer.' })
    expect(parseMcpArguments(`["${'\\u0061'.repeat(8_192)}"]`)).toEqual({ ok: true, args: ['a'.repeat(8_192)] })
  })

  it('bounds the combined decoded size independently of individual arguments', () => {
    const args = Array(4).fill('a'.repeat(8_192))
    expect(parseMcpArguments(JSON.stringify(args))).toMatchObject({ ok: true })
    expect(parseMcpArguments(JSON.stringify([...args, 'a']))).toMatchObject({ ok: false, error: expect.stringContaining('32,768') })
  })

  it('bounds raw input before JSON parsing or blank-input handling', () => {
    expect(parseMcpArguments(' '.repeat(199_998) + '[]')).toEqual({ ok: true, args: [] })
    expect(parseMcpArguments(' '.repeat(200_001))).toMatchObject({ ok: false, error: expect.stringContaining('200,000') })
    expect(parseMcpArguments('x'.repeat(200_001))).toMatchObject({ ok: false, error: expect.stringContaining('200,000') })
  })
})
