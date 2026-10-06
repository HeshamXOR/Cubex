// Minimal mock MCP stdio server for tests: newline-delimited JSON-RPC 2.0.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

rl.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } })
  } else if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
    })
  } else if (m.method === 'tools/call') {
    const args = m.params?.arguments ?? {}
    if (m.params?.name === 'echo') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] } })
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown tool' } })
    }
  }
  // notifications (no id) are ignored
})
