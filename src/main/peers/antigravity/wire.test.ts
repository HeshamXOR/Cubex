import { describe, expect, it } from 'vitest'
import { boundText, boundedPayload, commandOf, isInteraction, normalizePermissionRequest, normalizeSessionUpdate, normalizeToolCall, onlyPersonalSignIn } from './wire'

describe('bounding text', () => {
  it('leaves a short text and keeps the end of a long one, which says how a command finished', () => {
    expect(boundText('short')).toBe('short')
    const long = `${'a'.repeat(9_000)}THE END`
    const bounded = boundText(long)
    expect(bounded.startsWith('[Earlier output truncated]')).toBe(true)
    expect(bounded.endsWith('THE END')).toBe(true)
    expect(bounded.length).toBeLessThan(8_100)
  })
})

describe('a payload that is bounded', () => {
  it('has no picture in it, however it is written', () => {
    const out = boundedPayload({ shot: 'data:image/png;base64,AAAA', image: { type: 'image', data: 'AAAA', mimeType: 'image/png' }, blobbed: { mimeType: 'image/png', blob: 'AAAA' }, note: 'kept' }) as Record<string, unknown>
    expect(out).toEqual({ image: { type: 'image', mimeType: 'image/png' }, blobbed: { mimeType: 'image/png' }, note: 'kept' })
  })

  it('has output once, not twice', () => {
    expect(boundedPayload({ combinedOutput: 'ok', formattedOutput: 'ok', exitCode: 0 })).toEqual({ combinedOutput: 'ok', exitCode: 0 })
  })

  it('has no more entries and no more depth than a card can use', () => {
    const wide = boundedPayload({ list: Array.from({ length: 2_000 }, (_, index) => ({ index })) }) as { list: unknown[] }
    expect(wide.list.length).toBeLessThan(600)
    let deep: unknown = 'bottom'
    for (let level = 0; level < 30; level++) deep = { next: deep }
    expect(JSON.stringify(boundedPayload(deep))).not.toContain('bottom')
  })

  it('has a total of text that has a limit, so many long texts cannot add up to a lot', () => {
    const many = boundedPayload(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, 'x'.repeat(8_000)]))) as Record<string, string>
    expect(Object.values(many).join('').length).toBeLessThanOrEqual(64_000 + 100 * 40)
  })
})

describe('the command of a tool call', () => {
  it.each([
    [{ CommandLine: 'npm test' }, 'npm test'],
    [{ command_line: 'npm test' }, 'npm test'],
    [{ commandLine: ' npm test ' }, 'npm test'],
    [{ command: 'npm test' }, 'npm test'],
    [{ CommandLine: '', command: 'second' }, 'second']
  ])('is read from %j', (input, command) => {
    expect(commandOf(input)).toBe(command)
  })

  it.each([[{}], [{ command: 5 }], [{ command: ['a', 'b'] }], ['npm test'], [undefined], [null]])('is not read from %j', (input) => {
    expect(commandOf(input)).toBeUndefined()
  })
})

describe('a tool call put in order', () => {
  it('has its command under the name the rest of Cubex reads, and is a command when it has one and no kind', () => {
    const call = normalizeToolCall({ toolCallId: 'c1', title: 'Run command', rawInput: { CommandLine: 'npm test', Cwd: '/p' } })
    expect(call).toMatchObject({ kind: 'execute', rawInput: { CommandLine: 'npm test', command: 'npm test', Cwd: '/p' } })
  })

  it('keeps the kind the runtime gave it, and a command it already named', () => {
    expect(normalizeToolCall({ toolCallId: 'c', kind: 'other', rawInput: { CommandLine: 'ls' } })).toMatchObject({ kind: 'other' })
    expect(normalizeToolCall({ toolCallId: 'c', rawInput: { command: 'ls', CommandLine: 'other' } })).toMatchObject({ rawInput: { command: 'ls' } })
  })

  it('is not a command when it has none', () => {
    const call = normalizeToolCall({ toolCallId: 'c', title: 'Read a file', rawInput: { path: 'a.ts' } })
    expect(call.kind).toBeUndefined()
    expect(call).toMatchObject({ rawInput: { path: 'a.ts' } })
  })

  it('has its text and its pictures cut', () => {
    const call = normalizeToolCall({ toolCallId: 'c', title: 'x'.repeat(20_000), content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }], rawOutput: { combinedOutput: 'y'.repeat(20_000) } })
    expect((call.title as string).length).toBeLessThan(8_100)
    expect(JSON.stringify(call.content)).not.toContain('AAAA')
    expect((call.rawOutput as Record<string, string>).combinedOutput?.length).toBeLessThan(8_100)
  })

  it('keeps what it has no reason to touch', () => {
    const call = normalizeToolCall({ toolCallId: 'c', status: 'pending', locations: [{ path: '/p/a.ts', line: 3 }] })
    expect(call).toEqual({ toolCallId: 'c', status: 'pending', locations: [{ path: '/p/a.ts', line: 3 }] })
  })
})

describe('an update put in order', () => {
  it('is changed when it is about a tool call, whether it starts or goes on', () => {
    for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
      const out = normalizeSessionUpdate({ sessionId: 's', update: { sessionUpdate, toolCallId: 'c', rawInput: { CommandLine: 'ls' } } }) as { update: Record<string, unknown> }
      expect(out.update).toMatchObject({ kind: 'execute', rawInput: { command: 'ls' } })
    }
  })

  it('is as it came when it is about anything else, and so is whatever is not an update', () => {
    const message = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }
    expect(normalizeSessionUpdate(message)).toBe(message)
    expect(normalizeSessionUpdate(null)).toBeNull()
    expect(normalizeSessionUpdate({ sessionId: 's' })).toEqual({ sessionId: 's' })
  })
})

describe('a question for the person', () => {
  it('is a permission request about a call named interaction_', () => {
    expect(isInteraction({ toolCall: { toolCallId: 'interaction_7' } })).toBe(true)
    expect(isInteraction({ toolCall: { toolCallId: 'call_7' } })).toBe(false)
    expect(isInteraction({ toolCall: {} })).toBe(false)
    expect(isInteraction({})).toBe(false)
    expect(isInteraction(null)).toBe(false)
  })
})

describe('a permission request put in order', () => {
  it('has its tool call put in order and the rest as it was', () => {
    const out = normalizePermissionRequest({ sessionId: 's', options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }], toolCall: { toolCallId: 'c', rawInput: { CommandLine: 'ls' } } }) as Record<string, unknown>
    expect(out).toMatchObject({ sessionId: 's', options: [{ optionId: 'a' }], toolCall: { kind: 'execute', rawInput: { command: 'ls' } } })
    expect(normalizePermissionRequest('nonsense')).toBe('nonsense')
  })
})

describe('the ways to sign in', () => {
  const methods = [{ id: 'oauth-personal', name: 'Google' }, { id: 'oauth-business', name: 'Enterprise' }, { id: 'gemini-api-key', name: 'Key' }]

  it('are only the one Cubex uses, so a client has nothing to choose between', () => {
    expect(onlyPersonalSignIn({ protocolVersion: 1, authMethods: methods })).toEqual({ protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] })
  })

  it('are left as they were when that one is not among them, so nothing is hidden by mistake', () => {
    const result = { authMethods: methods.slice(1) }
    expect(onlyPersonalSignIn(result)).toBe(result)
    expect(onlyPersonalSignIn({ authMethods: [] })).toEqual({ authMethods: [] })
    expect(onlyPersonalSignIn({})).toEqual({})
    expect(onlyPersonalSignIn(null)).toBeNull()
  })
})
