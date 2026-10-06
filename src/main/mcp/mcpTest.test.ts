import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpSecretRef } from '@shared/policy'
import { testMcpServer, testTargetOf } from './mcpTest'

type McpTestTarget = Parameters<typeof testMcpServer>[0]

const fixture = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'richServer.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'cubex mcp test '))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** The fixture takes its behaviour from its first argument, so the variables under test stay exactly the ones a case sets. */
const target = (config: object = {}, over: Partial<McpTestTarget> = {}): McpTestTarget => ({
  name: 'Fixture', command: process.execPath, args: [fixture, JSON.stringify(config)], ...over
})

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
async function stopped(pidFile: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  const pid = (): number => Number(readFileSync(pidFile, 'utf8'))
  while (alive(pid())) {
    if (Date.now() > end) throw new Error('The server was left running')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('testMcpServer', () => {
  it('connects, lists the tools with their descriptions, and stops the server again', async () => {
    const pidFile = join(tmp, 'ok.pid')
    const result = await testMcpServer(target({ pidFile, toolCount: 3 }))
    expect(result.ok).toBe(true)
    expect(result.server).toEqual({ name: 'rich-mock', version: '2' })
    expect(result.protocolVersion).toBe('2025-11-25')
    expect(result.toolCount).toBe(14)
    expect(result.tools).toHaveLength(14)
    expect(result.tools[0]).toEqual({ name: 'echo', description: 'Echo text back' })
    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.error).toBeUndefined()
    await stopped(pidFile)
  })

  it('shows what the server printed while starting, with secrets redacted', async () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuv'
    const result = await testMcpServer(target({ stderrLines: 1, stderrSecret: secret }))
    expect(result.ok).toBe(true)
    expect(result.output).toContain('stderr line 0')
    expect(result.output).not.toContain(secret)
    expect(result.output).toContain('«redacted»')
  })

  it('caps the tool list but reports the real count', async () => {
    const result = await testMcpServer(target({ toolCount: 300 }))
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(311)
    expect(result.tools).toHaveLength(200)
  })

  it('says a command was not found and how to fix it', async () => {
    const result = await testMcpServer(target({}, { command: 'cubex-no-such-program', args: [] }))
    expect(result).toMatchObject({ ok: false, tools: [], toolCount: 0, error: '`cubex-no-such-program` was not found on PATH.' })
    expect(result.hint).toContain('full path')
  })

  it('reads a server that quits at once, with its output', async () => {
    const result = await testMcpServer(target({ stderrLines: 1, exitOnStart: 2 }))
    expect(result).toMatchObject({ ok: false, error: 'The server exited (code 2).' })
    expect(result.output).toContain('stderr line 0')
  })

  it('gives up on a server that never answers, and stops it', async () => {
    const pidFile = join(tmp, 'silent.pid')
    const started = Date.now()
    const result = await testMcpServer(target({ pidFile, noInitialize: true }), { startupTimeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result).toMatchObject({ ok: false, error: 'The server did not answer the MCP handshake in time.' })
    await stopped(pidFile)
  })

  it('stops a server that is still slow when the whole test runs out of time', async () => {
    const pidFile = join(tmp, 'slow.pid')
    const result = await testMcpServer(target({ pidFile, initDelayMs: 10_000 }), { deadlineMs: 400 })
    expect(result).toMatchObject({ ok: false, error: 'The server did not answer the MCP handshake in time.' })
    await stopped(pidFile)
  })

  it('never reports a failed test as a rejection', async () => {
    await expect(testMcpServer(target({}, { command: '' }))).resolves.toMatchObject({ ok: false })
  })
})

describe('testMcpServer with variables', () => {
  const secret = 'tok-9f8e7d6c5b4a'

  it('gives the server its plain variables and its secrets, and hides the secrets in what it printed', async () => {
    const result = await testMcpServer(target(
      { stderrEnv: ['SENTRY_ORG', 'SENTRY_ACCESS_TOKEN'] },
      { env: { SENTRY_ORG: 'lumen', SENTRY_ACCESS_TOKEN: secret }, secretValues: [secret] }
    ))
    expect(result.ok).toBe(true)
    expect(result.output).toContain('env SENTRY_ORG=lumen')
    expect(result.output).toContain('env SENTRY_ACCESS_TOKEN=«redacted»')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('does not need the value to be marked secret to hide a credential-looking variable', async () => {
    const result = await testMcpServer(target({ stderrEnv: ['API_KEY'] }, { env: { API_KEY: secret } }))
    expect(result.output).toBe('env API_KEY=«redacted»')
  })

  it('hides a secret in the output of a server that failed to start, and in the sentences about it', async () => {
    const result = await testMcpServer(target(
      { stderrEnv: ['SENTRY_ACCESS_TOKEN'], stderrSecret: secret, exitOnStart: 1 },
      { env: { SENTRY_ACCESS_TOKEN: secret }, secretValues: [secret] }
    ))
    expect(result).toMatchObject({ ok: false, error: 'The server exited (code 1).' })
    expect(result.output).toContain('env SENTRY_ACCESS_TOKEN=«redacted»')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('hides a secret that the server turns up in its own protocol version', async () => {
    const result = await testMcpServer(target({ protocolVersion: secret }, { env: { TOKEN: secret }, secretValues: [secret] }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('«redacted»')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('points a server that asked for a token at the Environment variables field, naming the variable', async () => {
    const result = await testMcpServer(target({ stderrText: 'Error: SENTRY_ACCESS_TOKEN is required', exitOnStart: 1 }, { env: { SENTRY_ORG: 'lumen' } }))
    expect(result.ok).toBe(false)
    expect(result.hint).toBe('The server wants `SENTRY_ACCESS_TOKEN`, which it did not get. Add it under Environment variables for this server and turn on Secret.')
  })

  it('says the value was refused when the server was given that variable', async () => {
    const result = await testMcpServer(target(
      { stderrText: 'SENTRY_ACCESS_TOKEN rejected: 401 Unauthorized', exitOnStart: 1 },
      { env: { SENTRY_ACCESS_TOKEN: secret }, secretValues: [secret] }
    ))
    expect(result.hint).toBe('The server did not accept the value of `SENTRY_ACCESS_TOKEN`. Replace it under Environment variables for this server.')
  })

  it('does not start a server whose saved secret is gone, and names the variable', async () => {
    const pidFile = join(tmp, 'never-started.pid')
    const result = await testMcpServer(target({ pidFile }, { missingSecrets: ['SENTRY_ACCESS_TOKEN'] }))
    expect(result).toMatchObject({
      ok: false,
      tools: [],
      toolCount: 0,
      error: 'The saved value of `SENTRY_ACCESS_TOKEN` is no longer available. Enter it again in Settings.',
      hint: 'Open Environment variables on this server and enter the value again.'
    })
    expect(existsSync(pidFile)).toBe(false)
  })
})

describe('testTargetOf', () => {
  const reader = (values: Record<string, string>) => vi.fn((ref: string) => values[ref])

  it('keeps a request without variables as it was', () => {
    expect(testTargetOf({ name: 'Files', command: 'npx', args: ['-y', 'server'] }, reader({}))).toEqual({ name: 'Files', command: 'npx', args: ['-y', 'server'] })
    expect(testTargetOf({ name: 'Files', command: 'npx' }, reader({}))).toEqual({ name: 'Files', command: 'npx', args: [] })
  })

  it('passes plain variables on, and treats none of them as secret', () => {
    expect(testTargetOf({ name: 'x', command: 'npx', env: { REGION: 'eu' } }, reader({}))).toEqual({ name: 'x', command: 'npx', args: [], env: { REGION: 'eu' } })
  })

  it('uses a secret typed in the form as typed, and lists it as a value to hide', () => {
    expect(testTargetOf({ name: 'x', command: 'npx', env: { REGION: 'eu' }, secrets: { API_TOKEN: secretOf('typed') } }, reader({}))).toEqual({
      name: 'x', command: 'npx', args: [], env: { REGION: 'eu', API_TOKEN: secretOf('typed') }, secretValues: [secretOf('typed')]
    })
  })

  it('reads a saved secret through the reference its server and name produce, and nothing else', () => {
    const read = reader({ [mcpSecretRef('srv', 'API_TOKEN')]: secretOf('saved'), 'provider-openai': 'sk-provider' })
    const resolved = testTargetOf({ id: 'srv', name: 'x', command: 'npx', savedSecrets: ['API_TOKEN'] }, read)
    expect(resolved).toEqual({ name: 'x', command: 'npx', args: [], env: { API_TOKEN: secretOf('saved') }, secretValues: [secretOf('saved')] })
    expect(read.mock.calls).toEqual([[mcpSecretRef('srv', 'API_TOKEN')]])
  })

  it('names the saved secrets that cannot be read', () => {
    const resolved = testTargetOf({ id: 'srv', name: 'x', command: 'npx', savedSecrets: ['A_TOKEN', 'B_TOKEN'] }, reader({ [mcpSecretRef('srv', 'A_TOKEN')]: secretOf('a') }))
    expect(resolved.missingSecrets).toEqual(['B_TOKEN'])
    expect(resolved.env).toEqual({ A_TOKEN: secretOf('a') })
  })

  it('prefers the value typed over a saved one, which is how a replacement is tested before it is saved', () => {
    const read = reader({ [mcpSecretRef('srv', 'API_TOKEN')]: secretOf('old') })
    const resolved = testTargetOf({ id: 'srv', name: 'x', command: 'npx', secrets: { API_TOKEN: secretOf('new') }, savedSecrets: [] }, read)
    expect(resolved.env).toEqual({ API_TOKEN: secretOf('new') })
    expect(resolved.secretValues).toEqual([secretOf('new')])
  })

  it('does not read the store when nothing saved is asked for', () => {
    const read = reader({})
    testTargetOf({ id: 'srv', name: 'x', command: 'npx', env: { A: '1' } }, read)
    expect(read).not.toHaveBeenCalled()
  })
})

/** A value that is long enough to be hidden, and different for each purpose. */
function secretOf(purpose: string): string {
  return `value-for-${purpose}-0123456789`
}
