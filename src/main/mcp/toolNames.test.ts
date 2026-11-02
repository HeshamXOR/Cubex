import { describe, it, expect } from 'vitest'
import { assignServerSegments, assignToolNames, parseMcpToolName, MAX_TOOL_NAME_LENGTH } from './toolNames'

const VALID = /^[a-zA-Z0-9_-]{1,64}$/

describe('assignToolNames', () => {
  it('builds mcp__<server>__<tool> for plain names', () => {
    expect(assignToolNames('github', ['create_issue']).get('create_issue')).toBe('mcp__github__create_issue')
  })

  it('replaces characters providers reject', () => {
    const names = assignToolNames('s', ['get.user/v2', 'say hello', 'ok-name_1'])
    expect(names.get('get.user/v2')).toBe('mcp__s__get_user_v2')
    expect(names.get('say hello')).toBe('mcp__s__say_hello')
    expect(names.get('ok-name_1')).toBe('mcp__s__ok-name_1')
  })

  it('never exceeds 64 characters and stays valid', () => {
    const long = 'a_very_long_tool_name_'.repeat(8)
    const name = assignToolNames('github', [long]).get(long)!
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
    expect(name).toMatch(VALID)
    expect(name.startsWith('mcp__github__a_very_long')).toBe(true)
  })

  it('keeps truncated long names distinct when they share a prefix', () => {
    const a = 'shared_prefix_'.repeat(6) + 'alpha'
    const b = 'shared_prefix_'.repeat(6) + 'beta'
    const names = assignToolNames('srv', [a, b])
    expect(names.get(a)).not.toBe(names.get(b))
    for (const name of names.values()) expect(name).toMatch(VALID)
  })

  it('gives colliding sanitized names a deterministic suffix and leaves others alone', () => {
    const names = assignToolNames('s', ['a.b', 'a_b', 'plain'])
    const first = names.get('a.b')!
    const second = names.get('a_b')!
    expect(first).not.toBe(second)
    expect(first.startsWith('mcp__s__a_b_')).toBe(true)
    expect(second.startsWith('mcp__s__a_b_')).toBe(true)
    expect(names.get('plain')).toBe('mcp__s__plain')
  })
})

describe('assignServerSegments', () => {

  it('separates servers whose names slug the same, independent of order', () => {
    const servers = [{ id: 'id-one', name: 'My Server' }, { id: 'id-two', name: 'my_server' }, { id: 'id-three', name: 'Other' }]
    const forward = assignServerSegments(servers)
    const backward = assignServerSegments([...servers].reverse())
    expect(new Set(forward.values()).size).toBe(3)
    for (const server of servers) expect(backward.get(server.id)).toBe(forward.get(server.id))
    expect(forward.get('id-three')).toBe('other')
    for (const segment of forward.values()) expect(segment).not.toContain('__')
  })
})

describe('parseMcpToolName', () => {
  it('splits at the first double underscore after the prefix', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    expect(parseMcpToolName('mcp__github__a__b')).toEqual({ server: 'github', tool: 'a__b' })
  })

  it('round-trips generated names', () => {
    const server = assignServerSegments([{ id: 'u', name: 'Some Server' }]).get('u')!
    const name = assignToolNames(server, ['do.thing']).get('do.thing')!
    expect(parseMcpToolName(name)).toEqual({ server, tool: 'do_thing' })
  })
})
