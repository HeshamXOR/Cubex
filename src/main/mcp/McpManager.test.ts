import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpClient, McpServerSpec } from './McpClient'
import { McpManager } from './McpManager'

const fixture = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'richServer.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'cubex mcp manager '))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const spec = (id: string, name: string, config: object = {}, extra: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id, name, command: process.execPath, args: [fixture], env: { MOCK_CONFIG: JSON.stringify(config) }, ...extra
})

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let manager = new McpManager()
afterEach(() => {
  manager.disposeAll()
  manager = new McpManager()
})

/** The client the manager holds for a server, to look at its process. */
const clientOf = (id: string): McpClient => {
  const connection = (manager as unknown as { connections: Map<string, { client: McpClient }> }).connections.get(id)
  if (!connection) throw new Error(`No connection for ${id}`)
  return connection.client
}

describe('tool names', () => {
  it('come from the server name, never its id, and stay valid for every provider', async () => {
    const tools = await manager.getTools([spec('3f2c1a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'GitHub Tools')])
    const names = tools.map((tool) => tool.definition.name)
    expect(names).toContain('mcp__github_tools__echo')
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('shorten a long tool name instead of dropping the tool, and still call the real one', async () => {
    const long = `list_directory_with_sizes_${'and_more_'.repeat(8)}end`
    const tools = await manager.getTools([spec('fs', 'Files', { extraToolNames: [long] })])
    const adapted = tools.find((tool) => (tool.definition.description ?? '').includes(long))
    expect(adapted).toBeDefined()
    expect(adapted!.definition.name.length).toBeLessThanOrEqual(64)
    expect(adapted!.definition.name).toMatch(/^mcp__files__list_directory_with_sizes/)
    // The fixture answers an unknown tool with this error, which shows the server received its own name for it.
    const result = await adapted!.execute({}, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/unknown tool/)
  })

  it('stay distinct for two servers that share a name', async () => {
    const tools = await manager.getTools([spec('a', 'Docs'), spec('b', 'Docs')])
    const names = tools.map((tool) => tool.definition.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((name) => name.endsWith('__echo'))).toHaveLength(2)
  })

  it('give the model a plain object schema for every tool', async () => {
    const tools = await manager.getTools([spec('s', 'Schema')])
    for (const tool of tools) expect(tool.definition.inputSchema).toMatchObject({ type: 'object' })
  })
})

describe('status', () => {
  it('reads idle before anything ran, connected after, and failed once the server is gone', async () => {
    const server = spec('s1', 'Status')
    expect(manager.statusOf(server)).toMatchObject({ state: 'idle', toolCount: 0 })

    await manager.getTools([server])
    const connected = manager.statusOf(server)
    expect(connected).toMatchObject({ state: 'connected', server: { name: 'rich-mock' } })
    expect(connected.toolCount).toBeGreaterThan(5)
    expect(connected.tools.find((tool) => tool.name === 'echo')).toEqual({ name: 'echo', description: 'Echo text back' })

    process.kill(clientOf('s1').pid!, 'SIGKILL')
    await waitFor(() => manager.statusOf(server).state === 'failed')
    expect(manager.statusOf(server)).toMatchObject({ state: 'failed', error: expect.stringMatching(/exited/), tools: [] })

    // The next turn starts it again.
    await manager.getTools([server])
    expect(manager.statusOf(server).state).toBe('connected')
  })

  it('explains a command that cannot be found, with how to fix it', async () => {
    const missing: McpServerSpec = { id: 'm', name: 'Missing', command: 'cubex-no-such-program', args: [] }
    expect(await manager.getTools([missing])).toEqual([])
    expect(manager.statusOf(missing)).toMatchObject({
      state: 'failed',
      error: '`cubex-no-such-program` was not found on PATH.',
      hint: expect.stringContaining('full path')
    })
  })

  it('keeps what a failing server printed, redacted and without color codes', async () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuv'
    const failing = spec('f', 'Failing', { stderrLines: 2, stderrSecret: secret, exitOnStart: 3 })
    expect(await manager.getTools([failing])).toEqual([])
    const status = manager.statusOf(failing)
    expect(status.state).toBe('failed')
    expect(status.error).toBe('The server exited (code 3).')
    expect(status.output).toContain('stderr line 1')
    expect(status.output).not.toContain(secret)
  })
})

describe('turning servers off', () => {
  it('stops a server that is no longer in the list, and its leftover tools cannot start it again', async () => {
    const keep = spec('keep', 'Keep')
    const drop = spec('drop', 'Drop')
    const tools = await manager.getTools([keep, drop])
    const dropEcho = tools.find((tool) => tool.definition.name === 'mcp__drop__echo')!
    const pid = clientOf('drop').pid!
    const keepPid = clientOf('keep').pid!

    manager.retainOnly([keep])
    await waitFor(() => !alive(pid))
    expect(alive(keepPid)).toBe(true)
    expect(manager.statusOf(drop).state).toBe('idle')

    const late = await dropEcho.execute({ text: 'x' }, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(late.isError).toBe(true)
    expect(String(late.content)).toMatch(/turned off/)
    expect(() => clientOf('drop')).toThrow()
  })

  it('replaces a server whose command or arguments changed', async () => {
    await manager.getTools([spec('c', 'Changed')])
    const first = clientOf('c').pid!
    await manager.getTools([spec('c', 'Changed', {}, { args: [fixture, 'new argument'] })])
    await waitFor(() => !alive(first))
    expect(clientOf('c').pid).not.toBe(first)
    expect(manager.statusOf(spec('c', 'Changed', {}, { args: [fixture, 'new argument'] })).state).toBe('connected')
  })

  it('stops everything on dispose', async () => {
    await manager.getTools([spec('x', 'X'), spec('y', 'Y')])
    const pids = [clientOf('x').pid!, clientOf('y').pid!]
    manager.disposeAll()
    await waitFor(() => pids.every((pid) => !alive(pid)))
  })
})

describe('connecting several servers', () => {
  it('skips the one that fails and still returns the others', async () => {
    const tools = await manager.getTools([
      { id: 'bad', name: 'Bad', command: 'cubex-no-such-program', args: [] },
      spec('good', 'Good')
    ])
    expect(tools.map((tool) => tool.definition.name)).toContain('mcp__good__echo')
    expect(tools.some((tool) => tool.definition.name.startsWith('mcp__bad__'))).toBe(false)
  })
})

describe('environment variables', () => {
  const secret = 'tok-9f8e7d6c5b4a'
  const allow = { requestPermission: async () => ({ decision: 'allow' as const }) }

  /** A server given variables the way `enabledMcpSpecs` hands them over: plain and secret together, with the secret values listed. */
  const withVariables = (id: string, config: object, variables: Record<string, string>, secretValues: string[] = []): McpServerSpec =>
    spec(id, id, config, { env: { MOCK_CONFIG: JSON.stringify(config), ...variables }, ...(secretValues.length > 0 ? { secretValues } : {}) })

  it('gives the server its variables, and keeps a secret out of what a tool returns', async () => {
    const tools = await manager.getTools([withVariables('vars', {}, { REGION: 'eu', API_TOKEN: secret }, [secret])])
    const read = tools.find((tool) => tool.definition.name === 'mcp__vars__env')!
    expect((await read.execute({ name: 'REGION' }, allow)).content).toBe('eu')
    expect((await read.execute({ name: 'API_TOKEN' }, allow)).content).toBe('«redacted»')
  })

  it('starts a server again when a variable changed, and leaves it running when none did', async () => {
    await manager.getTools([withVariables('e', {}, { REGION: 'eu' })])
    const first = clientOf('e').pid!
    await manager.getTools([withVariables('e', {}, { REGION: 'eu' })])
    expect(clientOf('e').pid).toBe(first)

    await manager.getTools([withVariables('e', {}, { REGION: 'us' })])
    await waitFor(() => !alive(first))
    expect(clientOf('e').pid).not.toBe(first)
  })

  it('starts a server again when a secret was replaced, without the value being part of what is compared', async () => {
    await manager.getTools([withVariables('s', {}, { API_TOKEN: secret }, [secret])])
    const first = clientOf('s').pid!
    await manager.getTools([withVariables('s', {}, { API_TOKEN: `${secret}-new` }, [`${secret}-new`])])
    await waitFor(() => !alive(first))
    expect(clientOf('s').pid).not.toBe(first)
    const held = (manager as unknown as { connections: Map<string, { launch: string }> }).connections.get('s')!.launch
    expect(held).not.toContain(secret)
  })

  it('does not start a server whose secret cannot be read, and says which one in the status', async () => {
    const pidFile = join(tmp, 'gone.pid')
    const gone = spec('gone', 'Gone', { pidFile }, { missingSecrets: ['SENTRY_ACCESS_TOKEN'] })
    expect(await manager.getTools([gone])).toEqual([])
    expect(existsSync(pidFile)).toBe(false)
    expect(() => clientOf('gone')).toThrow()
    expect(manager.statusOf(gone)).toEqual({
      state: 'failed',
      tools: [],
      toolCount: 0,
      error: 'The saved value of `SENTRY_ACCESS_TOKEN` is no longer available. Enter it again in Settings.',
      hint: 'Open Environment variables on this server and enter the value again.',
      missingSecrets: ['SENTRY_ACCESS_TOKEN']
    })
  })

  it('stops a running server when its secret goes missing, and starts it again once the value is entered', async () => {
    const working = withVariables('rot', {}, { API_TOKEN: secret }, [secret])
    await manager.getTools([working])
    const pid = clientOf('rot').pid!

    const lost = spec('rot', 'rot', {}, { missingSecrets: ['API_TOKEN'] })
    expect(await manager.getTools([lost])).toEqual([])
    await waitFor(() => !alive(pid))
    expect(manager.statusOf(lost)).toMatchObject({ state: 'failed', missingSecrets: ['API_TOKEN'] })

    expect((await manager.getTools([working])).length).toBeGreaterThan(0)
    expect(manager.statusOf(working).state).toBe('connected')
  })

  it('hides a secret in the failed status, whatever it looks like', async () => {
    const failing = withVariables('hide', { stderrEnv: ['API_TOKEN'], exitOnStart: 3 }, { API_TOKEN: secret }, [secret])
    expect(await manager.getTools([failing])).toEqual([])
    const status = manager.statusOf(failing)
    expect(status.state).toBe('failed')
    expect(status.output).toContain('env API_TOKEN=«redacted»')
    expect(JSON.stringify(status)).not.toContain(secret)
  })

  it('tells a server that asked for a token from one that was given a token it did not accept', async () => {
    const asked = withVariables('asked', { stderrText: 'Error: SENTRY_ACCESS_TOKEN is required', exitOnStart: 1 }, { SENTRY_ORG: 'lumen' })
    await manager.getTools([asked])
    expect(manager.statusOf(asked).hint).toBe('The server wants `SENTRY_ACCESS_TOKEN`, which it did not get. Add it under Environment variables for this server and turn on Secret.')

    const refused = withVariables('refused', { stderrText: 'SENTRY_ACCESS_TOKEN rejected: 401 Unauthorized', exitOnStart: 1 }, { SENTRY_ACCESS_TOKEN: secret }, [secret])
    await manager.getTools([refused])
    expect(manager.statusOf(refused).hint).toBe('The server did not accept the value of `SENTRY_ACCESS_TOKEN`. Replace it under Environment variables for this server.')
  })
})
