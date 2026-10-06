import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { mcpSecretRef, type McpSecretSaveResult, type McpServerStatus, type McpTestResult } from '@shared/policy'

interface SavedServer {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  secretEnv?: Record<string, string>
  enabled: boolean
}

const mocks = vi.hoisted(() => ({
  servers: [] as SavedServer[],
  testMcpServer: vi.fn(),
  /** What the credential store holds: reference to value. */
  store: new Map<string, string>(),
  encryption: true,
  setSecret: vi.fn(),
  deleteSecret: vi.fn()
}))
vi.mock('../config', () => ({ getSettings: () => ({ mcpServers: mocks.servers }) }))
vi.mock('../credentials', () => ({
  getSecret: (ref: string | undefined) => (ref ? mocks.store.get(ref) : undefined),
  setSecret: (ref: string, value: string) => mocks.setSecret(ref, value),
  deleteSecret: (ref: string) => mocks.deleteSecret(ref),
  encryptionAvailable: () => mocks.encryption
}))
// The runner starts real processes; the step that decides what to start is the part under test here.
vi.mock('../mcp/mcpTest', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mcp/mcpTest')>()), testMcpServer: mocks.testMcpServer }))

import { register } from './mcp'

const passed = (over: Partial<McpTestResult> = {}): McpTestResult => ({ ok: true, durationMs: 40, tools: [{ name: 'echo' }], toolCount: 1, ...over })

const connections = {
  retainOnly: vi.fn(),
  statusOf: vi.fn((spec: { id: string }): Omit<McpServerStatus, 'id'> => ({ state: 'connected', tools: [{ name: 'echo' }], toolCount: 1, server: { name: spec.id } }))
}
let handlers: Map<string, (...args: unknown[]) => unknown>
const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => handlers.get(channel)!(...args) as Promise<T>

const value = 'the-value-123456'

beforeEach(() => {
  handlers = new Map()
  mocks.servers = []
  mocks.store.clear()
  mocks.encryption = true
  mocks.testMcpServer.mockReset().mockResolvedValue(passed())
  mocks.setSecret.mockReset().mockImplementation((ref: string, text: string) => { mocks.store.set(ref, text); return { ok: true, ref } })
  mocks.deleteSecret.mockReset().mockImplementation((ref: string) => { mocks.store.delete(ref) })
  connections.retainOnly.mockClear()
  connections.statusOf.mockClear()
  register({
    handle: (channel: string, fn: (...args: never[]) => unknown) => { handlers.set(channel, fn as (...args: unknown[]) => unknown) },
    chat: { mcpConnections: connections }
  } as never)
})

describe('mcp:test', () => {
  it('declares exactly its four channels while registering', () => {
    expect([...handlers.keys()].sort()).toEqual([IPC.mcpForgetSecrets, IPC.mcpSaveSecret, IPC.mcpStatus, IPC.mcpTest].sort())
  })

  it.each([
    undefined, null, 'npx', 42, [],
    { name: 'x' },
    { command: 'npx' },
    { name: '', command: 'npx' },
    { name: 'x', command: 'a\nb' },
    { name: 'x', command: 'npx', args: 'not a list' },
    { name: 'x', command: 'npx', args: [1] },
    { name: 'x', command: 'npx', id: '../../etc' },
    { name: 'x'.repeat(500), command: 'npx' },
    { name: 'x', command: 'npx', env: 'API_KEY=1' },
    { name: 'x', command: 'npx', env: { 'NOT OK': 'v' } },
    { name: 'x', command: 'npx', env: { '1ABC': 'v' } },
    { name: 'x', command: 'npx', env: { A: 1 } },
    { name: 'x', command: 'npx', env: { A: 'a\0b' } },
    { name: 'x', command: 'npx', secrets: { A_TOKEN: '' } },
    { name: 'x', command: 'npx', env: { A: '1' }, secrets: { a: '2222' } },
    { name: 'x', command: 'npx', savedSecrets: ['A_TOKEN'] },
    { id: 'srv', name: 'x', command: 'npx', savedSecrets: ['not a name'] },
    { id: 'srv', name: 'x', command: 'npx', savedSecrets: 'A_TOKEN' }
  ])('rejects a malformed request without starting anything: %j', async (request) => {
    await expect(call(IPC.mcpTest, request)).rejects.toThrow()
    expect(mocks.testMcpServer).not.toHaveBeenCalled()
  })

  it('hands the runner only the validated name, command and arguments, never a folder or a flag from the page', async () => {
    await call(IPC.mcpTest, { name: ' Files ', command: ' npx ', args: ['-y', 'server'], cwd: 'C:\\', enabled: true, shell: true })
    expect(mocks.testMcpServer).toHaveBeenCalledWith({ name: 'Files', command: 'npx', args: ['-y', 'server'] })
  })

  it('hands the runner the plain variables, and a secret typed in the form with its value marked for hiding', async () => {
    await call(IPC.mcpTest, { name: 'Files', command: 'npx', env: { REGION: 'eu' }, secrets: { API_TOKEN: value } })
    expect(mocks.testMcpServer).toHaveBeenCalledWith({
      name: 'Files', command: 'npx', args: [], env: { REGION: 'eu', API_TOKEN: value }, secretValues: [value]
    })
  })

  it('reads a saved secret from the credential store by the server id and the variable name', async () => {
    mocks.store.set(mcpSecretRef('srv', 'API_TOKEN'), value)
    await call(IPC.mcpTest, { id: 'srv', name: 'Files', command: 'npx', savedSecrets: ['API_TOKEN'] })
    expect(mocks.testMcpServer).toHaveBeenCalledWith({
      name: 'Files', command: 'npx', args: [], env: { API_TOKEN: value }, secretValues: [value]
    })
  })

  it('tells the runner which saved secrets cannot be read, instead of testing without them', async () => {
    await call(IPC.mcpTest, { id: 'srv', name: 'Files', command: 'npx', savedSecrets: ['API_TOKEN'] })
    expect(mocks.testMcpServer).toHaveBeenCalledWith({ name: 'Files', command: 'npx', args: [], missingSecrets: ['API_TOKEN'] })
  })

  it('does not read a credential that belongs to another server or to a provider', async () => {
    mocks.store.set(mcpSecretRef('other', 'API_TOKEN'), 'belongs-to-another-server')
    mocks.store.set('provider-openai', 'sk-provider-key-123')
    await call(IPC.mcpTest, { id: 'srv', name: 'Files', command: 'npx', savedSecrets: ['API_TOKEN', 'provider_openai'] })
    const [target] = mocks.testMcpServer.mock.calls[0] as [{ env?: Record<string, string>; missingSecrets?: string[] }]
    expect(target.env).toBeUndefined()
    expect(target.missingSecrets).toEqual(['API_TOKEN', 'provider_openai'])
  })

  it('returns the result as is, failures included', async () => {
    mocks.testMcpServer.mockResolvedValue(passed({ ok: false, tools: [], toolCount: 0, error: 'nope', hint: 'fix it' }))
    expect(await call(IPC.mcpTest, { name: 'x', command: 'npx' })).toMatchObject({ ok: false, error: 'nope', hint: 'fix it' })
  })

  it('answers busy instead of starting a fourth process at once', async () => {
    const release: Array<() => void> = []
    mocks.testMcpServer.mockImplementation(() => new Promise<McpTestResult>((resolve) => { release.push(() => resolve(passed())) }))
    const running = [1, 2, 3].map(() => call<McpTestResult>(IPC.mcpTest, { name: 'x', command: 'npx' }))
    const fourth = await call<McpTestResult>(IPC.mcpTest, { name: 'x', command: 'npx' })
    expect(fourth).toMatchObject({ ok: false, error: 'Other connection tests are still running.' })
    expect(mocks.testMcpServer).toHaveBeenCalledTimes(3)
    release.forEach((done) => done())
    await Promise.all(running)
    // A slot is free again.
    mocks.testMcpServer.mockResolvedValue(passed())
    await call(IPC.mcpTest, { name: 'x', command: 'npx' })
    expect(mocks.testMcpServer).toHaveBeenCalledTimes(4)
  })

  it('frees its slot when the runner throws', async () => {
    mocks.testMcpServer.mockRejectedValue(new Error('boom'))
    for (let i = 0; i < 5; i++) await expect(call(IPC.mcpTest, { name: 'x', command: 'npx' })).rejects.toThrow('boom')
  })

  it('never repeats a value in the error for a request it refuses', async () => {
    const failure = await call(IPC.mcpTest, { name: 'x', command: 'npx', env: { A: `a\0${value}` } }).catch((error: Error) => error.message)
    expect(String(failure)).toContain('A')
    expect(String(failure)).not.toContain(value)
  })
})

describe('mcp:status', () => {
  beforeEach(() => {
    mocks.servers = [
      { id: 'a', name: 'Files', command: 'npx', args: ['-y', 'x'], enabled: true },
      { id: 'b', name: 'Docs', command: 'uvx', enabled: false },
      { id: 'c', name: 'Git', command: 'git-mcp', enabled: true }
    ]
  })

  it('lists every saved server in order, reading live state only for the enabled ones', async () => {
    const status = await call<McpServerStatus[]>(IPC.mcpStatus)
    expect(status.map((entry) => [entry.id, entry.state])).toEqual([['a', 'connected'], ['b', 'disabled'], ['c', 'connected']])
    expect(status[1]).toEqual({ id: 'b', state: 'disabled', tools: [], toolCount: 0 })
    expect(connections.statusOf).toHaveBeenCalledTimes(2)
  })

  it('lets go of servers that are off before reporting', async () => {
    await call(IPC.mcpStatus)
    expect(connections.retainOnly).toHaveBeenCalledWith([
      { id: 'a', name: 'Files', command: 'npx', args: ['-y', 'x'] },
      { id: 'c', name: 'Git', command: 'git-mcp' }
    ])
  })

  it('shows the last test of a saved server, and forgets servers that were removed', async () => {
    await call(IPC.mcpTest, { id: 'a', name: 'Files', command: 'npx' })
    mocks.testMcpServer.mockResolvedValue(passed({ ok: false, tools: [], toolCount: 0, error: 'It exited.' }))
    await call(IPC.mcpTest, { id: 'c', name: 'Git', command: 'git-mcp' })
    await call(IPC.mcpTest, { name: 'Unsaved', command: 'npx' })

    const status = await call<McpServerStatus[]>(IPC.mcpStatus)
    expect(status[0]!.lastTest).toMatchObject({ ok: true, toolCount: 1 })
    expect(status[1]!.lastTest).toBeUndefined()
    expect(status[2]!.lastTest).toMatchObject({ ok: false, toolCount: 0, error: 'It exited.' })
    expect(typeof status[0]!.lastTest!.at).toBe('number')

    mocks.servers = mocks.servers.filter((server) => server.id !== 'a')
    expect((await call<McpServerStatus[]>(IPC.mcpStatus)).some((entry) => entry.lastTest?.ok === true)).toBe(false)
    mocks.servers = [{ id: 'a', name: 'Files again', command: 'npx', enabled: true }]
    expect((await call<McpServerStatus[]>(IPC.mcpStatus))[0]!.lastTest).toBeUndefined()
  })

  it('reports no servers when none are saved', async () => {
    mocks.servers = []
    expect(await call(IPC.mcpStatus)).toEqual([])
  })

  describe('with environment variables', () => {
    beforeEach(() => {
      mocks.servers = [
        { id: 'a', name: 'Files', command: 'npx', env: { REGION: 'eu' }, secretEnv: { API_TOKEN: mcpSecretRef('a', 'API_TOKEN') }, enabled: true },
        { id: 'b', name: 'Docs', command: 'uvx', secretEnv: { DOCS_TOKEN: mcpSecretRef('b', 'DOCS_TOKEN') }, enabled: false },
        { id: 'c', name: 'Git', command: 'git-mcp', secretEnv: { GIT_TOKEN: mcpSecretRef('c', 'GIT_TOKEN') }, enabled: true }
      ]
      mocks.store.set(mcpSecretRef('c', 'GIT_TOKEN'), value)
    })

    it('starts servers with their variables and their secret values resolved, and hides nothing it should not', async () => {
      await call(IPC.mcpStatus)
      expect(connections.retainOnly).toHaveBeenCalledWith([
        { id: 'a', name: 'Files', command: 'npx', env: { REGION: 'eu' }, missingSecrets: ['API_TOKEN'] },
        { id: 'c', name: 'Git', command: 'git-mcp', env: { GIT_TOKEN: value }, secretValues: [value] }
      ])
    })

    it('names the secrets whose saved value is gone, for a server that is on and for one that is off', async () => {
      const status = await call<McpServerStatus[]>(IPC.mcpStatus)
      expect(status[0]!.missingSecrets).toEqual(['API_TOKEN'])
      expect(status[1]).toEqual({ id: 'b', state: 'disabled', tools: [], toolCount: 0, missingSecrets: ['DOCS_TOKEN'] })
      expect(status[2]!.missingSecrets).toBeUndefined()
    })

    it('never sends a secret value to the page', async () => {
      expect(JSON.stringify(await call(IPC.mcpStatus))).not.toContain(value)
    })
  })
})

describe('mcp:save-secret', () => {
  const save = (over: Record<string, unknown> = {}) => call<McpSecretSaveResult>(IPC.mcpSaveSecret, { serverId: 'srv', name: 'API_TOKEN', value, ...over })

  it('keeps the value in the credential store under the reference made from the server and the variable, and returns only that reference', async () => {
    const result = await save()
    expect(result).toEqual({ ok: true, ref: 'mcp-env:srv:API_TOKEN' })
    expect(mocks.setSecret).toHaveBeenCalledWith('mcp-env:srv:API_TOKEN', value)
    expect(JSON.stringify(result)).not.toContain(value)
  })

  it('makes the reference itself, so a page cannot write into a credential that belongs to something else', async () => {
    await save({ ref: 'provider-openai', credentialRef: 'provider-openai' })
    expect(mocks.setSecret).toHaveBeenCalledTimes(1)
    expect(mocks.store.has('provider-openai')).toBe(false)
    expect(mocks.store.get('mcp-env:srv:API_TOKEN')).toBe(value)
  })

  it('replaces the value of a secret that is already saved', async () => {
    await save()
    await save({ value: `${value}-new` })
    expect(mocks.store.get('mcp-env:srv:API_TOKEN')).toBe(`${value}-new`)
  })

  it.each([
    undefined, null, 'text', [],
    {},
    { serverId: '../etc', name: 'A', value: 'v' },
    { serverId: '', name: 'A', value: 'v' },
    { serverId: 'srv', name: '1A', value: 'v' },
    { serverId: 'srv', name: 'A B', value: 'v' },
    { serverId: 'srv', name: '', value: 'v' },
    { serverId: 'srv', name: 'A', value: '' },
    { serverId: 'srv', name: 'A', value: 5 },
    { serverId: 'srv', name: 'A', value: 'a\0b' },
    { serverId: 'srv', name: 'A', value: 'x'.repeat(9_000) }
  ])('rejects a malformed request and saves nothing: %j', async (request) => {
    await expect(call(IPC.mcpSaveSecret, request)).rejects.toThrow()
    expect(mocks.setSecret).not.toHaveBeenCalled()
  })

  it('does not repeat the value in the error for a value it refuses', async () => {
    const message = await save({ value: `${value}\0` }).catch((error: Error) => error.message)
    expect(String(message)).toContain('API_TOKEN')
    expect(String(message)).not.toContain(value)
  })

  it('says so when this computer has no credential store, and does not try to save', async () => {
    mocks.encryption = false
    const result = await save()
    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message).toMatch(/credential store/)
    expect(mocks.setSecret).not.toHaveBeenCalled()
  })

  it('says it could not save when the store refuses, without the store\'s own words', async () => {
    mocks.setSecret.mockReturnValue({ ok: false, ref: 'x', message: `refused ${value}` })
    const result = await save()
    expect(result).toEqual({ ok: false, message: 'The secret could not be saved. Check that Cubex can write to its data folder, then try again.' })
  })

  it('says it could not save when the store throws, and does not pass the error on', async () => {
    mocks.setSecret.mockImplementation(() => { throw new Error(`EACCES writing ${value}`) })
    const result = await save()
    expect(result).toEqual({ ok: false, message: 'The secret could not be saved. Check that Cubex can write to its data folder, then try again.' })
    expect(JSON.stringify(result)).not.toContain(value)
  })
})

describe('mcp:forget-secrets', () => {
  it('deletes each named secret by the reference its server and name produce, once', async () => {
    mocks.store.set(mcpSecretRef('srv', 'A_TOKEN'), 'one-111111')
    mocks.store.set(mcpSecretRef('srv', 'B_TOKEN'), 'two-222222')
    mocks.store.set(mcpSecretRef('other', 'A_TOKEN'), 'three-333333')
    expect(await call(IPC.mcpForgetSecrets, { serverId: 'srv', names: ['A_TOKEN', 'B_TOKEN', 'A_TOKEN'] })).toBeUndefined()
    expect(mocks.deleteSecret.mock.calls).toEqual([['mcp-env:srv:A_TOKEN'], ['mcp-env:srv:B_TOKEN']])
    expect([...mocks.store.keys()]).toEqual(['mcp-env:other:A_TOKEN'])
  })

  it('does nothing for an empty list', async () => {
    await call(IPC.mcpForgetSecrets, { serverId: 'srv', names: [] })
    expect(mocks.deleteSecret).not.toHaveBeenCalled()
  })

  it.each([
    undefined, null, 'text', [],
    {},
    { serverId: '../etc', names: ['A'] },
    { serverId: 'srv' },
    { serverId: 'srv', names: 'A' },
    { serverId: 'srv', names: [1] },
    { serverId: 'srv', names: ['provider-openai'] },
    { serverId: 'srv', names: Array.from({ length: 40 }, (_, index) => `V${index}`) }
  ])('rejects a malformed request and deletes nothing: %j', async (request) => {
    await expect(call(IPC.mcpForgetSecrets, request)).rejects.toThrow()
    expect(mocks.deleteSecret).not.toHaveBeenCalled()
  })
})
