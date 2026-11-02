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

  it('reads a saved secret from the credential store by the server id and the variable name', async () => {
    mocks.store.set(mcpSecretRef('srv', 'API_TOKEN'), value)
    await call(IPC.mcpTest, { id: 'srv', name: 'Files', command: 'npx', savedSecrets: ['API_TOKEN'] })
    expect(mocks.testMcpServer).toHaveBeenCalledWith({
      name: 'Files', command: 'npx', args: [], env: { API_TOKEN: value }, secretValues: [value]
    })
  })

  it('does not read a credential that belongs to another server or to a provider', async () => {
    mocks.store.set(mcpSecretRef('other', 'API_TOKEN'), 'belongs-to-another-server')
    mocks.store.set('provider-openai', 'sk-provider-key-123')
    await call(IPC.mcpTest, { id: 'srv', name: 'Files', command: 'npx', savedSecrets: ['API_TOKEN', 'provider_openai'] })
    const [target] = mocks.testMcpServer.mock.calls[0] as [{ env?: Record<string, string>; missingSecrets?: string[] }]
    expect(target.env).toBeUndefined()
    expect(target.missingSecrets).toEqual(['API_TOKEN', 'provider_openai'])
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

  describe('with environment variables', () => {
    beforeEach(() => {
      mocks.servers = [
        { id: 'a', name: 'Files', command: 'npx', env: { REGION: 'eu' }, secretEnv: { API_TOKEN: mcpSecretRef('a', 'API_TOKEN') }, enabled: true },
        { id: 'b', name: 'Docs', command: 'uvx', secretEnv: { DOCS_TOKEN: mcpSecretRef('b', 'DOCS_TOKEN') }, enabled: false },
        { id: 'c', name: 'Git', command: 'git-mcp', secretEnv: { GIT_TOKEN: mcpSecretRef('c', 'GIT_TOKEN') }, enabled: true }
      ]
      mocks.store.set(mcpSecretRef('c', 'GIT_TOKEN'), value)
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
})
