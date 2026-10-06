import { describe, it, expect, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpClient } from './McpClient'
import { McpManager } from './McpManager'

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, '__fixtures__', 'mockServer.mjs')
const spec = { id: 'mock', name: 'Mock', command: process.execPath, args: [server] }

const client = new McpClient(spec)
const manager = new McpManager()
afterAll(() => {
  client.close()
  manager.disposeAll()
})

describe('McpClient', () => {
  it('connects, lists tools, and calls a tool over stdio JSON-RPC', async () => {
    await client.connect()
    expect(client.connected).toBe(true)
    expect(client.tools.map((t) => t.name)).toContain('echo')
    const r = await client.callTool('echo', { text: 'hi' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe('echo: hi')
  })

  it('surfaces a server-side error as isError', async () => {
    const r = await client.callTool('nope', {})
    expect(r.isError).toBe(true)
  })
})

describe('McpManager', () => {
  it('adapts server tools into namespaced ExecutableTools', async () => {
    const tools = await manager.getTools([spec])
    const echo = tools.find((t) => t.definition.name === 'mcp__mock__echo')
    expect(echo).toBeTruthy()
    expect(echo!.defaultPermission).toBe('ask')
    const res = await echo!.execute({ text: 'yo' }, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(String(res.content)).toBe('echo: yo')
  })

  it('describes a namespaced tool name', () => {
    expect(McpManager.describe('mcp__mock__echo')).toBe('mock · echo')
    expect(McpManager.describe('read_file')).toBeUndefined()
  })
})
