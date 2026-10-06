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

  it('accepts an older protocol version the server negotiates down to', async () => {
    const client = make(spec({ protocolVersion: '2024-11-05' }))
    await client.connect()
    expect(client.protocolVersion).toBe('2024-11-05')
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

  it('ignores non-JSON noise on stdout', async () => {
    const client = make(spec({ noisyStdout: true }))
    await client.connect()
    expect(client.connected).toBe(true)
  })

  it('passes arguments with spaces, quotes and non-ASCII characters to the server unchanged', async () => {
    const args = [fixture, 'two words', 'say "hi"', 'café 中', '--json={"a":1}']
    const client = make(spec({}, { args }))
    await client.connect()
    expect(JSON.parse((await client.callTool('argv', {})).text)).toEqual(args.slice(1))
  })

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

describe('tool listing', () => {
  it('follows cursor pagination to the end', async () => {
    const logFile = join(tmp, 'p1.log')
    const client = make(spec({ toolCount: 7, pageSize: 3, logFile }))
    await client.connect()
    expect(client.tools.filter((t) => /^t\d+$/.test(t.name))).toHaveLength(7)
    expect(client.tools.some((t) => t.name === 'echo')).toBe(true)
    const cursors = readLog(logFile).filter((m) => m.method === 'tools/list').map((m) => m.params?.cursor)
    expect(cursors[0]).toBeUndefined()
    expect(cursors.slice(1, 3)).toEqual(['3', '6'])
  })

  it('stops when a server keeps returning the same cursor', async () => {
    const client = make(spec({ pageSize: 2, loopCursor: true }))
    await client.connect()
    expect(client.tools).toHaveLength(2)
  }, 15000)

  it('refreshes the list on notifications/tools/list_changed and tells listeners', async () => {
    const client = make(spec({}))
    let notified = 0
    client.onToolsChanged(() => { notified++ })
    await client.connect()
    await client.callTool('add_tool', { name: 'fresh' })
    await waitFor(() => client.tools.some((t) => t.name === 'fresh'))
    expect(notified).toBeGreaterThan(0)
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

  it('does not call the server at all when the signal is already aborted', async () => {
    const logFile = join(tmp, 'c3.log')
    const client = make(spec({ logFile }))
    await client.connect()
    const controller = new AbortController()
    controller.abort()
    const result = await client.callTool('echo', { text: 'x' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(readLog(logFile).some((m) => m.method === 'tools/call')).toBe(false)
  })

  it('handles many concurrent calls', async () => {
    const client = make(spec({}))
    await client.connect()
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client.callTool('echo', { text: String(i) })))
    expect(results.map((r) => r.text)).toEqual(Array.from({ length: 8 }, (_, i) => `echo: ${i}`))
  })

  it('connects on demand when a call arrives before connect()', async () => {
    const client = make(spec({}))
    expect((await client.callTool('echo', { text: 'lazy' })).text).toBe('echo: lazy')
    expect(client.connected).toBe(true)
  })

  it('answers server ping requests and rejects unknown server requests', async () => {
    const client = make(spec({}))
    await client.connect()
    expect((await client.callTool('server_ping', {})).text).toBe('pong ok')
    expect((await client.callTool('server_unknown', {})).text).toBe('error -32601')
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

describe('stderr', () => {
  it('captures stderr, forwards it to the logger, and redacts secret values', async () => {
    const logs: string[] = []
    const secret = 's3cr3t-value-123456'
    const client = make(spec({ stderrLines: 3, stderrSecret: secret }, { env: { MOCK_CONFIG: JSON.stringify({ stderrLines: 3, stderrSecret: secret }), SERVICE_PASSPHRASE: secret } }), {
      log: (_level, message) => { logs.push(message) }
    })
    await client.connect()
    await waitFor(() => client.stderrTail.includes('stderr line 2') && client.stderrTail.includes('starting with token'))
    expect(client.stderrTail).not.toContain(secret)
    expect(client.stderrTail).toContain('«redacted»')
    await waitFor(() => logs.some((l) => l.includes('stderr line 0')))
    expect(logs.join('\n')).not.toContain(secret)
  })

  it('keeps the stderr buffer and the log volume bounded for a noisy server', async () => {
    const logs: string[] = []
    const client = make(spec({ stderrLines: 20000, stderrWidth: 100 }), { log: (_level, message) => { logs.push(message) } })
    await client.connect()
    await client.callTool('echo', { text: 'responsive' })
    expect(client.stderrTail.length).toBeLessThanOrEqual(8192)
    expect(logs.length).toBeLessThan(500)
  }, 20000)
})

describe('environment and secrets', () => {
  const secret = 'tok-9f8e7d6c5b4a'

  it('gives the server its own variables on top of the inherited ones', async () => {
    const client = make(spec({}, { env: { MOCK_CONFIG: '{}', REGION: 'eu-west-1' } }))
    await client.connect()
    expect((await client.callTool('env', { name: 'REGION' })).text).toBe('eu-west-1')
  })

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

  it('holds back the start of a secret that is still arriving, so a failure that interrupts it shows none of it', async () => {
    const config = { stderrParts: ['token tok-9f8e7d'], noInitialize: true }
    const client = make(spec(config, { env: { MOCK_CONFIG: JSON.stringify(config), SERVICE_TOKEN: secret }, secretValues: [secret], startupTimeoutMs: 1_500 }))
    await expect(client.connect()).rejects.toThrow(/timed out/)
    expect(client.stderrTail).toBe('token ')
  })

  it('hides the value of a plain variable that is named like a credential', async () => {
    const client = make(spec({}, { env: { MOCK_CONFIG: '{}', API_KEY: 'plain-key-value-1', REGION: 'eu-west-1' } }))
    await client.connect()
    expect((await client.callTool('env', { name: 'API_KEY' })).text).toBe('«redacted»')
    expect((await client.callTool('env', { name: 'REGION' })).text).toBe('eu-west-1')
  })

  it('lets a credential given on purpose through the filter that keeps the inherited ones out', async () => {
    process.env.SERVICE_TOKEN = 'inherited-from-my-shell'
    try {
      const client = make(spec({}))
      await client.connect()
      expect((await client.callTool('env', { name: 'SERVICE_TOKEN' })).text).toBe('(no content)')
      const given = make(spec({}, { env: { MOCK_CONFIG: '{}', SERVICE_TOKEN: secret }, secretValues: [secret] }))
      await given.connect()
      expect((await given.callTool('env', { name: 'SERVICE_TOKEN' })).text).toBe('«redacted»')
    } finally {
      delete process.env.SERVICE_TOKEN
    }
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

  it('backs off exponentially with jitter after failed connects and refuses early retries', async () => {
    let now = 1_000_000
    const client = make({ id: 'bad', name: 'Bad', command: join(tmp, 'does-not-exist') }, { now: () => now, random: () => 0.5 })
    await expect(client.connect()).rejects.toThrow()
    expect(client.failures).toBe(1)
    expect(client.retryAt - now).toBe(750)
    await expect(client.connect()).rejects.toThrow(/retry in/i)
    expect(client.failures).toBe(1)
    now = client.retryAt + 1
    await expect(client.connect()).rejects.toThrow()
    expect(client.failures).toBe(2)
    expect(client.retryAt - now).toBe(1500)
  })

  it('resets the backoff after a successful connect', async () => {
    const client = make(spec({}))
    await client.connect()
    expect(client.failures).toBe(0)
  })
})

describe('shutdown', () => {
  it('shuts down gracefully by closing stdin when the server cooperates', async () => {
    const client = make(spec({}))
    await client.connect()
    const pid = client.pid!
    expect(alive(pid)).toBe(true)
    const started = Date.now()
    await client.close()
    expect(Date.now() - started).toBeLessThan(2500)
    await waitFor(() => !alive(pid))
    expect(client.connected).toBe(false)
  })

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

  it('kill() stops the whole tree immediately without waiting for a grace period', async () => {
    const pidFile = join(tmp, 'tree2.pid')
    const client = make(spec({ childPidFile: pidFile }))
    await client.connect()
    const pid = client.pid!
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    client.kill()
    await waitFor(() => !alive(pid) && !alive(grandchild), 8000)
  }, 20000)

  it('close() is safe to call twice and before connecting', async () => {
    const client = make(spec({}))
    await client.close()
    await client.connect()
    await client.close()
    await client.close()
    expect(client.connected).toBe(false)
  })
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

  it('survives calls that race with the server exiting', async () => {
    const client = make(spec({}))
    await client.connect()
    process.kill(client.pid!, 'SIGKILL')
    // Straight away, before the exit has been noticed: these writes may hit a closed pipe.
    const first = await client.callTool('echo', { text: 'x' })
    expect(first.isError).toBe(true)
    expect(first.text).toMatch(/exited|stopped reading its input|not running/)
    expect((await client.callTool('echo', { text: 'y' })).text).toBe('echo: y')
  })

  it('starts one server when several callers connect at the same time', async () => {
    const logFile = join(tmp, 'shared-connect.log')
    const client = make(spec({ logFile }))
    await Promise.all([client.connect(), client.connect(), client.callTool('echo', { text: 'x' })])
    expect(readLog(logFile).filter((m) => m.method === 'initialize')).toHaveLength(1)
  })

  it('keeps the output and exit code of a server that quits before it speaks', async () => {
    const client = make(spec({ stderrLines: 2, exitOnStart: 1 }))
    await expect(client.connect()).rejects.toThrow(/exited with code 1/)
    expect(client.connected).toBe(false)
    expect(client.lastError).toMatch(/exited with code 1/)
    expect(client.lastExit).toMatchObject({ code: 1 })
    expect(client.stderrTail).toContain('stderr line 1')
  })

  it('ignores lines that are valid JSON but not messages', async () => {
    const client = make(spec({ junkLines: true }))
    await client.connect()
    expect((await client.callTool('echo', { text: 'ok' })).text).toBe('echo: ok')
  })

  it('does not start again once it was retired', async () => {
    const client = make(spec({}))
    await client.connect()
    const pid = client.pid!
    client.retire()
    await waitFor(() => !alive(pid))
    const result = await client.callTool('echo', { text: 'x' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/turned off/)
    expect(client.pid).toBeUndefined()
  })
})
