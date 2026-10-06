// Configurable mock MCP stdio server for lifecycle tests. Newline-delimited JSON-RPC 2.0.
// Behaviour comes from the MOCK_CONFIG environment variable (JSON), or from the first argument when it is not set.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const config = JSON.parse(process.env.MOCK_CONFIG || process.argv[2] || '{}')
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const record = (m) => { if (config.logFile) appendFileSync(config.logFile, JSON.stringify(m) + '\n') }
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid))

for (let i = 0; i < (config.stderrLines ?? 0); i++) process.stderr.write(`stderr line ${i} ${'.'.repeat(config.stderrWidth ?? 0)}\n`)
if (config.stderrSecret) process.stderr.write(`starting with token ${config.stderrSecret} now\n`)
// One line of the server's own words, such as the complaint a server prints when it was not given a token.
if (config.stderrText) process.stderr.write(`${config.stderrText}\n`)
// What the server was given, printed the way a careless server would.
for (const name of config.stderrEnv ?? []) process.stderr.write(`env ${name}=${process.env[name] ?? '(unset)'}\n`)
// One message cut in pieces with a pause between them, so a value can arrive split across two reads.
for (const [index, part] of (config.stderrParts ?? []).entries()) setTimeout(() => process.stderr.write(part), 60 * (index + 1))
if (config.noisyStdout) process.stdout.write('this line is not JSON\n')
// Lines that parse as JSON but are not messages: a client reading `.method` off them must not throw.
if (config.junkLines) for (const line of ['null', '123', '[]', '"text"', 'true']) process.stdout.write(`${line}\n`)
// Exit before speaking MCP at all, like a server that fails on its arguments. The empty write's callback runs after the stderr lines above are flushed.
if (config.exitOnStart !== undefined) process.stderr.write('', () => process.exit(config.exitOnStart))
if (config.childPidFile) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(config.childPidFile, String(grandchild.pid))
}

const extraTools = []
for (let i = 0; i < (config.toolCount ?? 0); i++) extraTools.push({ name: `t${i}`, description: `Tool ${i}`, inputSchema: { type: 'object', properties: {} } })
for (const name of config.extraToolNames ?? []) extraTools.push({ name, description: `Tool ${name}`, inputSchema: { type: 'object', properties: {} } })
const baseTools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'sleep', description: 'Sleep then answer', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'big', description: 'Return a large text', inputSchema: { type: 'object', properties: { chars: { type: 'number' } } } },
  { name: 'blocks', description: 'Return mixed content blocks', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exit the process', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_tool', description: 'Add a tool and announce it', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'env', description: 'Read an environment variable', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'argv', description: 'Return the arguments', inputSchema: { type: 'object', properties: {} } },
  { name: 'server_ping', description: 'Send a ping request to the client', inputSchema: { type: 'object', properties: {} } },
  { name: 'server_unknown', description: 'Send an unknown request to the client', inputSchema: { type: 'object', properties: {} } }
]
const tools = [...baseTools, ...extraTools]
const cancelled = new Set()
const waiting = new Map()
const ok = (m, result) => send({ jsonrpc: '2.0', id: m.id, result })
const text = (m, value, extra = {}) => ok(m, { content: [{ type: 'text', text: value }], ...extra })

function page(list, params, key) {
  const size = config.pageSize
  if (!size) return { [key]: list }
  if (config.loopCursor) return { [key]: list.slice(0, size), nextCursor: 'same' }
  const offset = params?.cursor ? Number(params.cursor) : 0
  const next = offset + size
  return { [key]: list.slice(offset, next), ...(next < list.length ? { nextCursor: String(next) } : {}) }
}

const handlers = {
  initialize: (m) => {
    if (config.noInitialize) return
    const reply = () => ok(m, {
      protocolVersion: config.protocolVersion ?? m.params?.protocolVersion ?? '2025-11-25',
      capabilities: config.capabilities ?? { tools: { listChanged: true } },
      serverInfo: { name: 'rich-mock', version: '2' },
      ...(config.instructions ? { instructions: config.instructions } : {})
    })
    config.initDelayMs ? setTimeout(reply, config.initDelayMs) : reply()
  },
  ping: (m) => ok(m, {}),
  'tools/list': (m) => ok(m, page(tools, m.params, 'tools')),
  'resources/list': (m) => ok(m, { resources: [{ uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain', description: 'Some notes' }] }),
  'resources/read': (m) => {
    if (m.params?.uri === 'file:///notes.txt') return ok(m, { contents: [{ uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'note body' }] })
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Resource not found' } })
  },
  'prompts/list': (m) => ok(m, { prompts: [{ name: 'review', description: 'Review code', arguments: [{ name: 'file', description: 'Path', required: true }] }] }),
  'prompts/get': (m) => {
    if (m.params?.name !== 'review') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown prompt' } })
    ok(m, { description: 'Review a file', messages: [{ role: 'user', content: { type: 'text', text: `Please review ${m.params?.arguments?.file ?? 'nothing'}` } }] })
  },
  'tools/call': (m) => {
    const args = m.params?.arguments ?? {}
    switch (m.params?.name) {
      case 'echo': return text(m, `echo: ${args.text ?? ''}`)
      case 'sleep': {
        const timer = setTimeout(() => { waiting.delete(m.id); if (!cancelled.has(m.id)) text(m, 'slept') }, args.ms ?? 1000)
        waiting.set(m.id, timer)
        return
      }
      case 'big': return text(m, 'x'.repeat(args.chars ?? 1000))
      case 'blocks':
        return ok(m, {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
            { type: 'resource', resource: { uri: 'file:///r.txt', mimeType: 'text/plain', text: 'embedded' } },
            { type: 'resource_link', uri: 'file:///link.md', name: 'link' }
          ],
          structuredContent: { answer: 42 }
        })
      case 'fail': return text(m, 'it broke', { isError: true })
      case 'crash': process.exit(3)
      // eslint-disable-next-line no-fallthrough
      case 'add_tool':
        tools.push({ name: args.name ?? 'added', description: 'Added later', inputSchema: { type: 'object', properties: {} } })
        text(m, 'added')
        return send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      case 'env': return text(m, process.env[args.name] ?? '')
      case 'argv': return text(m, JSON.stringify(process.argv.slice(2)))
      case 'server_ping': {
        waiting.set('srv-ping', (reply) => text(m, reply.result && Object.keys(reply.result).length === 0 ? 'pong ok' : `bad reply ${JSON.stringify(reply)}`))
        return send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })
      }
      case 'server_unknown': {
        waiting.set('srv-unknown', (reply) => text(m, reply.error ? `error ${reply.error.code}` : 'unexpected success'))
        return send({ jsonrpc: '2.0', id: 'srv-unknown', method: 'sampling/createMessage', params: {} })
      }
      default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown tool' } })
    }
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  record(m)
  if (m.method === 'notifications/cancelled') {
    const id = m.params?.requestId
    cancelled.add(id)
    const timer = waiting.get(id)
    if (typeof timer === 'object') { clearTimeout(timer); waiting.delete(id) }
    return
  }
  if (m.method === undefined && m.id !== undefined && typeof waiting.get(m.id) === 'function') {
    const done = waiting.get(m.id)
    waiting.delete(m.id)
    return done(m)
  }
  if (m.id === undefined) return
  const handler = handlers[m.method]
  if (handler) handler(m)
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } })
})
if (config.exitOnStdinEnd === false) {
  process.stdin.on('end', () => setInterval(() => {}, 1000))
} else {
  rl.on('close', () => process.exit(0))
}
