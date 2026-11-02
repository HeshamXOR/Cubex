import { describe, expect, it } from 'vitest'
import { allowTool, denyTool, isSignedOut, LineSplitter, parseMessage, readAccount } from './protocol'

const split = (chunks: string[], max?: number): { lines: string[]; splitter: LineSplitter } => {
  const lines: string[] = []
  const splitter = new LineSplitter((line) => lines.push(line), max)
  for (const chunk of chunks) splitter.push(chunk)
  return { lines, splitter }
}

describe('lines', () => {
  it('are cut where a program ends them, however its output was split up', () => {
    expect(split(['{"a":1}\n{"b"', ':2}\n', '{"c":3}\n']).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(split(['x', 'y', 'z\nw\n']).lines).toEqual(['xyz', 'w'])
  })

  it('drop a line that runs past the cap, and the rest of it, and go on with the next', () => {
    const { lines, splitter } = split(['aaaaaaaaaaaa', 'bbbb\nok\n'], 10)
    expect(lines).toEqual(['ok'])
    expect(splitter.dropped).toBe(1)
  })
})

describe('a message', () => {
  it('is a line that holds one object', () => {
    expect(parseMessage('{"type":"result"}')).toEqual({ type: 'result' })
    expect(parseMessage('  {"type":"result"}  ')).toEqual({ type: 'result' })
  })
})

describe('what Cubex sends', () => {

  it('answers a question about a tool with the input it was given, or with a reason', () => {
    expect(allowTool('r2', { file_path: 'a' })).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r2', response: { behavior: 'allow', updatedInput: { file_path: 'a' } } } })
    expect(denyTool('r3', 'No.')).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r3', response: { behavior: 'deny', message: 'No.' } } })
  })
})

describe('the account', () => {
  it('is read as where the login came from, and never as the login', () => {
    expect(readAccount({ tokenSource: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', organization: 'x', token: 'secret' })).toEqual({ tokenSource: 'claude.ai', apiProvider: 'firstParty' })
    expect(readAccount({ apiKeySource: 'ANTHROPIC_API_KEY' })).toEqual({ apiKeySource: 'ANTHROPIC_API_KEY' })
    expect(readAccount({})).toEqual({})
  })

  it.each([
    [{ tokenSource: 'none' }, true],
    [{ tokenSource: 'none', apiProvider: 'firstParty' }, true],
    [{ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }, false],
    [{ tokenSource: 'none', apiProvider: 'bedrock' }, false],
    [{ tokenSource: 'none', apiProvider: 'vertex' }, false],
    [{ tokenSource: 'claude.ai', apiProvider: 'firstParty' }, false],
    [{ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }, false],
    [{ apiProvider: 'firstParty' }, false],
    [{}, false],
    [undefined, false]
  ])('%j is signed out: %s', (account, signedOut) => {
    expect(isSignedOut(account)).toBe(signedOut)
  })
})
