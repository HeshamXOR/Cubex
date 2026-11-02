import { createServer, type Server } from 'node:http'

/**
 * A scripted stand-in for the Anthropic Messages API, for trying the real Claude Code without an account or a network: it
 * answers each request for the model with the next turn of a script, as a stream of server-sent events. Claude Code is pointed
 * at it with ANTHROPIC_BASE_URL. The small requests it makes on the side (a title, a check that the key works) get "ok".
 */

export type MockBlock = { text: string } | { tool: string; input: Record<string, unknown> }

export interface MockApi {
  /** Where to point ANTHROPIC_BASE_URL. */
  url: string
  /** The bodies of the requests for the model, in order: what the model was shown each time. */
  requests: Array<{ messages: Array<{ role: string; content: unknown }> }>
  close(): Promise<void>
}

export async function startAnthropicMock(script: MockBlock[][]): Promise<MockApi> {
  let turn = 0
  const requests: MockApi['requests'] = []
  const event = (response: import('node:http').ServerResponse, name: string, data: unknown): void => { response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`) }

  const stream = (response: import('node:http').ServerResponse, blocks: MockBlock[], model: string): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    event(response, 'message_start', { type: 'message_start', message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
    let usedTool = false
    blocks.forEach((block, index) => {
      if ('text' in block) {
        event(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        event(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      } else {
        usedTool = true
        event(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${turn}_${index}`, name: block.tool, input: {} } })
        event(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      }
      event(response, 'content_block_stop', { type: 'content_block_stop', index })
    })
    event(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: usedTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
    event(response, 'message_stop', { type: 'message_stop' })
    response.end()
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: { model?: string; stream?: boolean; max_tokens?: number; messages?: MockApi['requests'][number]['messages'] } = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* not json */ }
      const url = request.url ?? ''
      if (url.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"input_tokens":100}')
        return
      }
      if (request.method === 'POST' && url.startsWith('/v1/messages')) {
        const model = String(body.model ?? 'claude-mock')
        const small = /haiku/i.test(model) || (typeof body.max_tokens === 'number' && body.max_tokens <= 64)
        if (small) {
          if (body.stream) return stream(response, [{ text: 'ok' }], model)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'msg_small', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }))
          return
        }
        requests.push({ messages: body.messages ?? [] })
        const blocks = script[Math.min(turn, script.length - 1)]!
        turn++
        return stream(response, blocks, model)
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"type":"not_found_error","message":"not found"}}')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
}
