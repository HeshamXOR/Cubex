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

  it('is deterministic and independent of input order', () => {
    const tools = ['a.b', 'a_b', 'x y', 'x_y', 'zed', 'é', 'e']
    const forward = assignToolNames('srv', tools)
    const backward = assignToolNames('srv', [...tools].reverse())
    for (const tool of tools) expect(backward.get(tool)).toBe(forward.get(tool))
    expect(assignToolNames('srv', tools).get('a.b')).toBe(forward.get('a.b'))
  })

  it('handles names with no usable characters', () => {
    const names = assignToolNames('s', ['日本語', '한국어'])
    for (const name of names.values()) expect(name).toMatch(VALID)
    expect(new Set(names.values()).size).toBe(2)
  })

  it('produces valid unique names for a large pseudo-random set', () => {
    let seed = 7
    const rand = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
    const alphabet = 'ab._ -/é日:'
    const tools = new Set<string>()
    while (tools.size < 600) {
      let name = ''
      const length = 1 + Math.floor(rand() * 90)
      for (let i = 0; i < length; i++) name += alphabet[Math.floor(rand() * alphabet.length)]
      tools.add(name)
    }
    const names = assignToolNames('some_server', [...tools])
    expect(names.size).toBe(tools.size)
    expect(new Set(names.values()).size).toBe(tools.size)
    for (const name of names.values()) expect(name).toMatch(VALID)
  })
})

describe('assignServerSegments', () => {
  it('slugs the display name', () => {
    const map = assignServerSegments([{ id: 'u1', name: 'My Server! (prod)' }])
    expect(map.get('u1')).toBe('my_server_prod')
  })

  it('falls back to the id when the name has no usable characters', () => {
    const map = assignServerSegments([{ id: '3f2a1c4e-5b6d', name: '日本語' }])
    expect(map.get('3f2a1c4e-5b6d')).toBe('3f2a1c4e-5b6d')
  })

  it('never contains a double underscore and does not start or end with one', () => {
    const map = assignServerSegments([{ id: 'u', name: '__weird__name__' }])
    expect(map.get('u')).toBe('weird_name')
  })

  it('limits the length so tool names keep room', () => {
    const map = assignServerSegments([{ id: 'u', name: 'modelcontextprotocol-filesystem-server-extra' }])
    expect(map.get('u')!.length).toBeLessThanOrEqual(24)
  })

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

  it('returns undefined for other names', () => {
    expect(parseMcpToolName('read_file')).toBeUndefined()
    expect(parseMcpToolName('mcp__nothing')).toBeUndefined()
  })

  it('round-trips generated names', () => {
    const server = assignServerSegments([{ id: 'u', name: 'Some Server' }]).get('u')!
    const name = assignToolNames(server, ['do.thing']).get('do.thing')!
    expect(parseMcpToolName(name)).toEqual({ server, tool: 'do_thing' })
  })
})
