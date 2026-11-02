import { describe, it, expect, afterEach, afterAll } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { McpClient, type McpServerSpec } from './McpClient'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '__fixtures__', 'richServer.mjs')
// A directory with a space in its name, on purpose: paths with spaces were a classic source of launch bugs.
const tmp = mkdtempSync(join(tmpdir(), 'cubex mcp '))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const clients: McpClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.kill()
})

function spec(config: object, extra: Partial<McpServerSpec> = {}): McpServerSpec {
  const { env, ...rest } = extra
  return { id: 'rich', name: 'Rich', command: process.execPath, args: [fixture], env: { MOCK_CONFIG: JSON.stringify(config), ...(env ?? {}) }, ...rest }
}
const make = (s: McpServerSpec, options?: ConstructorParameters<typeof McpClient>[1]): McpClient => {
  const client = new McpClient(s, options)
  clients.push(client)
  return client
}
/** One JSON-RPC line the mock server logged: only the fields these tests look at. */
interface LoggedMessage {
  id?: number
  method?: string
  params?: { name?: string; cursor?: string; requestId?: number; reason?: string }
}
const readLog = (file: string): LoggedMessage[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LoggedMessage) : []
async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

describe('handshake', () => {
  it('runs initialize, initialized, then tools/list in order', async () => {
    const logFile = join(tmp, 'h1.log')
    const client = make(spec({ logFile }))
    await client.connect()
    expect(client.connected).toBe(true)
    expect(client.protocolVersion).toBe('2025-11-25')
    expect(client.serverInfo).toMatchObject({ name: 'rich-mock' })
    const log = readLog(logFile)
    expect(log[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Cubex' } } })
    expect(log[1]).toMatchObject({ method: 'notifications/initialized' })
    expect(log[2]).toMatchObject({ method: 'tools/list' })
  })

  it('rejects a protocol version Cubex does not speak', async () => {
    await expect(make(spec({ protocolVersion: '1999-01-01' })).connect()).rejects.toThrow(/protocol version "1999-01-01"/)
  })

  it('times out when the server never answers initialize, and cleans up', async () => {
    const client = make(spec({ noInitialize: true }, { startupTimeoutMs: 300 }))
    const started = Date.now()
    await expect(client.connect()).rejects.toThrow(/timed out/i)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(client.connected).toBe(false)
  }, 15000)

  it('scrubs Cubex credentials from the environment but passes the entry env', async () => {
    process.env.CUBEX_TEST_SECRET = 'leak'
    try {
      const client = make(spec({}, { env: { MOCK_CONFIG: '{}', MY_SETTING: 'visible' } }))
      await client.connect()
      expect((await client.callTool('env', { name: 'CUBEX_TEST_SECRET' })).text).toBe('(no content)')
      expect((await client.callTool('env', { name: 'MY_SETTING' })).text).toBe('visible')
    } finally {
      delete process.env.CUBEX_TEST_SECRET
    }
  })
})

describe('requests', () => {
  it('times out a slow call, reports it, and sends notifications/cancelled', async () => {
    const logFile = join(tmp, 'c1.log')
    const client = make(spec({ logFile }))
    await client.connect()
    const result = await client.callTool('sleep', { ms: 5000 }, { timeoutMs: 200 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/timed out/i)
    await waitFor(() => readLog(logFile).some((m) => m.method === 'notifications/cancelled'))
    const log = readLog(logFile)
    const call = log.find((m) => m.method === 'tools/call' && m.params?.name === 'sleep')!
    const cancel = log.find((m) => m.method === 'notifications/cancelled')!
    expect(cancel.params?.requestId).toBe(call.id)
    expect(cancel.params?.reason).toMatch(/timed out/i)
    expect((await client.callTool('echo', { text: 'alive' })).text).toBe('echo: alive')
  })

  it('cancels a call when the abort signal fires', async () => {
    const logFile = join(tmp, 'c2.log')
    const client = make(spec({ logFile }))
    await client.connect()
    const controller = new AbortController()
    const pending = client.callTool('sleep', { ms: 5000 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/cancel/i)
    await waitFor(() => readLog(logFile).some((m) => m.method === 'notifications/cancelled'))
  })

  it('maps content blocks, structuredContent and isError', async () => {
    const client = make(spec({}))
    await client.connect()
    const blocks = await client.callTool('blocks', {})
    expect(blocks.isError).toBe(false)
    expect(blocks.text).toContain('hello')
    expect(blocks.text).toContain('[image omitted: image/png')
    expect(blocks.text).toContain('embedded')
    expect(blocks.text).toContain('file:///link.md')
    expect(blocks.text).toContain('Structured content: {"answer":42}')
    expect(await client.callTool('fail', {})).toMatchObject({ isError: true, text: 'it broke' })
  })

  it('caps a very large result and says so', async () => {
    const client = make(spec({}, { maxResultChars: 500 }))
    await client.connect()
    const result = await client.callTool('big', { chars: 100_000 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(800)
    expect(result.text).toMatch(/capped at 500 characters/)
  })
})

describe('environment and secrets', () => {
  const secret = 'tok-9f8e7d6c5b4a'

  it('passes a secret to the server, and hides it in everything the client reports back', async () => {
    const logs: string[] = []
    const client = make(
      spec({ stderrEnv: ['SERVICE_TOKEN', 'REGION'] }, { env: { MOCK_CONFIG: JSON.stringify({ stderrEnv: ['SERVICE_TOKEN', 'REGION'] }), SERVICE_TOKEN: secret, REGION: 'eu-west-1' }, secretValues: [secret] }),
      { log: (_level, message) => { logs.push(message) } }
    )
    await client.connect()
    // The server did receive the value: it is what the client hides, and only an exact match is hidden.
    expect((await client.callTool('env', { name: 'SERVICE_TOKEN' })).text).toBe('«redacted»')
    expect((await client.callTool('echo', { text: `the token is ${secret}` })).text).toBe('echo: the token is «redacted»')
    await waitFor(() => client.stderrTail.includes('env REGION='))
    expect(client.stderrTail).toContain('env SERVICE_TOKEN=«redacted»')
    expect(client.stderrTail).toContain('env REGION=eu-west-1')
    await waitFor(() => logs.some((line) => line.includes('env REGION=')))
    expect(logs.join('\n')).not.toContain(secret)
    expect(logs.join('\n')).toContain('env SERVICE_TOKEN=«redacted»')
  })

  it('hides a secret that arrives in two pieces', async () => {
    const logs: string[] = []
    const parts = ['token tok-9f8e7d', '6c5b4a ends here\n']
    const client = make(
      spec({ stderrParts: parts }, { env: { MOCK_CONFIG: JSON.stringify({ stderrParts: parts }), SERVICE_TOKEN: secret }, secretValues: [secret] }),
      { log: (_level, message) => { logs.push(message) } }
    )
    await client.connect()
    await waitFor(() => client.stderrTail.includes('ends here'))
    expect(client.stderrTail).toContain('token «redacted» ends here')
    expect(client.stderrTail).not.toContain('tok-9f8e7d')
    await waitFor(() => logs.some((line) => line.includes('ends here')))
    expect(logs.join('\n')).not.toContain('tok-9f8e7d')
  })

  it('does not start a server whose secret has no saved value, and says which one', async () => {
    const logFile = join(tmp, 'never-started.log')
    const client = make(spec({ logFile }, { missingSecrets: ['SERVICE_TOKEN'] }))
    const sentence = 'The saved value of `SERVICE_TOKEN` is no longer available. Enter it again in Settings.'
    await expect(client.connect()).rejects.toThrow(sentence)
    expect(client.pid).toBeUndefined()
    expect(client.lastError).toBe(sentence)
    expect(existsSync(logFile)).toBe(false)
    // Nothing was tried, so nothing counts as a failed attempt and the reason does not turn into a retry pause.
    expect(client.failures).toBe(0)
    await expect(client.connect()).rejects.toThrow(sentence)
    expect(await client.callTool('echo', { text: 'x' })).toEqual({ text: `Tool call failed: ${sentence}`, isError: true, truncated: false })
  })
})

describe('reconnect and backoff', () => {
  it('reports a crash mid-call and reconnects on the next connect', async () => {
    const client = make(spec({}))
    await client.connect()
    const result = await client.callTool('crash', {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/exited/i)
    expect(client.connected).toBe(false)
    await client.connect()
    expect(client.connected).toBe(true)
    expect((await client.callTool('echo', { text: 'back' })).text).toBe('echo: back')
  })
})

describe('shutdown', () => {

  it('kills a server that ignores stdin closing, together with its child processes', async () => {
    const pidFile = join(tmp, 'tree1.pid')
    const client = make(spec({ childPidFile: pidFile, exitOnStdinEnd: false }, { shutdownGraceMs: 200 }))
    await client.connect()
    const pid = client.pid!
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(pid) && alive(grandchild)).toBe(true)
    await client.close()
    await waitFor(() => !alive(pid) && !alive(grandchild), 8000)
  }, 20000)
})

describe('a server that dies or breaks its pipe', () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('fails the request that is waiting when the server is killed, then starts a new server on the next use', async () => {
    const client = make(spec({}))
    await client.connect()
    const first = client.pid!
    const waiting = client.callTool('sleep', { ms: 10_000 })
    await pause(150) // the request has reached the server
    const killedAt = Date.now()
    process.kill(first, 'SIGKILL')
    const result = await waiting
    expect(Date.now() - killedAt).toBeLessThan(3000) // not left to the 20 second request timeout
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/MCP server "Rich" exited/)
    expect(client.connected).toBe(false)
    expect(client.lastError).toMatch(/exited/)

    expect((await client.callTool('echo', { text: 'back' })).text).toBe('echo: back')
    expect(client.connected).toBe(true)
    expect(client.pid).not.toBe(first)
    expect(client.lastError).toBeUndefined()
  })

  it('treats a broken input pipe as a lost connection instead of crashing, and stops the half-dead server', async () => {
    const client = make(spec({}))
    await client.connect()
    const first = client.pid!
    const waiting = client.callTool('sleep', { ms: 10_000 })
    await pause(150)
    // What a write to a dead child produces: an `error` event on stdin. With no listener it would crash the app.
    const { stdin } = (client as unknown as { child: ChildProcessWithoutNullStreams }).child
    stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    const result = await waiting
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/stopped reading its input \(EPIPE\)/)
    expect(client.connected).toBe(false)
    await waitFor(() => !alive(first))

    expect((await client.callTool('echo', { text: 'again' })).text).toBe('echo: again')
    expect(client.pid).not.toBe(first)
  })
})
