import { describe, expect, it } from 'vitest'
import { allowTool, controlRequest, denyTool, isSignedOut, LineSplitter, looksSignedOut, parseMessage, readAccount, refuseRequest, stopReasonOf, userMessage } from './protocol'

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

  it('keep a line that has no end until the program ends, and then count it', () => {
    const { lines, splitter } = split(['one\ntwo'])
    expect(lines).toEqual(['one'])
    splitter.end()
    expect(lines).toEqual(['one', 'two'])
    splitter.end()
    expect(lines).toEqual(['one', 'two'])
  })

  it('drop a line that runs past the cap, and the rest of it, and go on with the next', () => {
    const { lines, splitter } = split(['aaaaaaaaaaaa', 'bbbb\nok\n'], 10)
    expect(lines).toEqual(['ok'])
    expect(splitter.dropped).toBe(1)
  })

  it('do not count a half line past the cap as a last line', () => {
    const { lines, splitter } = split(['a'.repeat(20)], 10)
    splitter.end()
    expect(lines).toEqual([])
  })
})

describe('a message', () => {
  it('is a line that holds one object', () => {
    expect(parseMessage('{"type":"result"}')).toEqual({ type: 'result' })
    expect(parseMessage('  {"type":"result"}  ')).toEqual({ type: 'result' })
  })

  it.each(['', '   ', 'plain text', '[1,2]', '"string"', '42', 'null', '{"unclosed":', '{} trailing', 'Warning: {"type":"x"}'])('is not %j', (line) => {
    expect(parseMessage(line)).toBeUndefined()
  })
})

describe('what Cubex sends', () => {
  it('asks Claude Code something as a control request', () => {
    expect(controlRequest('r1', { subtype: 'interrupt' })).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } })
  })

  it('sends a message as the user, with no session of its own to name', () => {
    expect(userMessage('hello')).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null, session_id: '' })
  })

  it('answers a question about a tool with the input it was given, or with a reason', () => {
    expect(allowTool('r2', { file_path: 'a' })).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r2', response: { behavior: 'allow', updatedInput: { file_path: 'a' } } } })
    expect(denyTool('r3', 'No.')).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r3', response: { behavior: 'deny', message: 'No.' } } })
  })

  it('refuses a request it does not serve as an error', () => {
    expect(refuseRequest('r4', 'Not here.')).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'r4', error: 'Not here.' } })
  })
})

describe('the account', () => {
  it('is read as where the login came from, and never as the login', () => {
    expect(readAccount({ tokenSource: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', organization: 'x', token: 'secret' })).toEqual({ tokenSource: 'claude.ai', apiProvider: 'firstParty' })
    expect(readAccount({ apiKeySource: 'ANTHROPIC_API_KEY' })).toEqual({ apiKeySource: 'ANTHROPIC_API_KEY' })
    expect(readAccount({})).toEqual({})
  })

  it('is nothing when the program did not say, and ignores what is not text', () => {
    expect(readAccount(undefined)).toBeUndefined()
    expect(readAccount('x')).toBeUndefined()
    expect(readAccount([1])).toBeUndefined()
    expect(readAccount({ tokenSource: 5, apiProvider: '' })).toEqual({})
  })

  it('is cut to a length no name needs', () => {
    expect(readAccount({ tokenSource: 'x'.repeat(500) })?.tokenSource).toHaveLength(80)
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

describe('what Claude Code says when it has no login', () => {
  it.each([
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'authentication_error'
  ])('%s', (message) => {
    expect(looksSignedOut(message)).toBe(true)
  })

  it.each(['API Error: 529 overloaded_error', 'Credit balance is too low', 'Prompt is too long', 'The build failed with 4010 errors', ''])('is not %j', (message) => {
    expect(looksSignedOut(message)).toBe(false)
  })
})

describe('how a turn ended', () => {
  it.each([
    [{ subtype: 'success', stop_reason: 'end_turn' }, 'end_turn'],
    [{ subtype: 'success', stop_reason: 'max_tokens' }, 'max_tokens'],
    [{ subtype: 'success', stop_reason: 'refusal' }, 'refusal'],
    [{ subtype: 'error_max_turns' }, 'max_turn_requests'],
    [{ subtype: 'success' }, 'end_turn'],
    [{ subtype: 'success', stop_reason: 'something_new' }, 'end_turn']
  ])('%j is %s', (result, reason) => {
    expect(stopReasonOf(result)).toBe(reason)
  })
})
