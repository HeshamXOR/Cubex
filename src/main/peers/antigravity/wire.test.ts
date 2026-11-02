import { describe, expect, it } from 'vitest'
import { boundedPayload, commandOf, isInteraction, normalizeToolCall, onlyPersonalSignIn } from './wire'

describe('a payload that is bounded', () => {
  it('has no picture in it, however it is written', () => {
    const out = boundedPayload({ shot: 'data:image/png;base64,AAAA', image: { type: 'image', data: 'AAAA', mimeType: 'image/png' }, blobbed: { mimeType: 'image/png', blob: 'AAAA' }, note: 'kept' }) as Record<string, unknown>
    expect(out).toEqual({ image: { type: 'image', mimeType: 'image/png' }, blobbed: { mimeType: 'image/png' }, note: 'kept' })
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
})

describe('a tool call put in order', () => {
  it('has its command under the name the rest of Cubex reads, and is a command when it has one and no kind', () => {
    const call = normalizeToolCall({ toolCallId: 'c1', title: 'Run command', rawInput: { CommandLine: 'npm test', Cwd: '/p' } })
    expect(call).toMatchObject({ kind: 'execute', rawInput: { CommandLine: 'npm test', command: 'npm test', Cwd: '/p' } })
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

describe('the ways to sign in', () => {
  const methods = [{ id: 'oauth-personal', name: 'Google' }, { id: 'oauth-business', name: 'Enterprise' }, { id: 'gemini-api-key', name: 'Key' }]

  it('are only the one Cubex uses, so a client has nothing to choose between', () => {
    expect(onlyPersonalSignIn({ protocolVersion: 1, authMethods: methods })).toEqual({ protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] })
  })
})
