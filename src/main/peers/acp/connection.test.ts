import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpClosedError, AcpConnection, AcpRequestError, AcpTimeoutError, RPC_ERROR, type AcpConnectionOptions } from './connection'

/** A connection over two pipes the test holds the other ends of: `agent` is what the program prints, `sent` what Cubex wrote to it. */
function setup(over: Partial<AcpConnectionOptions> = {}) {
  const agent = new PassThrough()
  const toAgent = new PassThrough()
  const notes: Array<[string, unknown]> = []
  const connection = new AcpConnection(agent, toAgent, {
    onNotification: (method, params) => { notes.push([method, params]) },
    onRequest: async (method) => { throw new AcpRequestError(RPC_ERROR.methodNotFound, `Method not found: ${method}`) },
    ...over
  })
  const written: string[] = []
  toAgent.setEncoding('utf8')
  toAgent.on('data', (chunk: string) => written.push(chunk))
  const say = (value: unknown): void => { agent.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`) }
  const sent = (): unknown[] => written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))
  return { connection, agent, toAgent, notes, say, sent, tick }
}

describe('reading what the program prints', () => {
  it('reads several messages in one piece, and one message in several', async () => {
    const { connection, agent, notes, tick } = setup()
    agent.write('{"jsonrpc":"2.0","method":"a","params":1}\n{"jsonrpc":"2.0","method":"b","params":2}\n{"jsonrpc":"2.0","met')
    agent.write('hod":"c","params":3}\n')
    await tick()
    expect(notes).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(connection.ignored).toBe(0)
  })

  it('reads a character that arrives in two pieces', async () => {
    const { agent, notes, tick } = setup()
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"n","params":"é😀"}\n', 'utf8')
    const cut = bytes.indexOf(0xf0) + 2
    agent.write(bytes.subarray(0, cut))
    agent.write(bytes.subarray(cut))
    await tick()
    expect(notes).toEqual([['n', 'é😀']])
  })

  it('reads lines that end in CRLF and start with a byte order mark', async () => {
    const { agent, notes, tick } = setup()
    agent.write('\uFEFF{"jsonrpc":"2.0","method":"a"}\r\n{"jsonrpc":"2.0","method":"b"}\r\n')
    await tick()
    expect(notes.map(([method]) => method)).toEqual(['a', 'b'])
  })

  it('counts and drops what is not a message, and goes on', async () => {
    const { connection, say, notes, tick } = setup()
    say('Debugger listening on ws://127.0.0.1:9229')
    say('[1,2,3]')
    say('42')
    say('"text"')
    say('null')
    say({ hello: 'world' })
    say('')
    say({ jsonrpc: '2.0', method: 'ok' })
    await tick()
    expect(connection.ignored).toBe(6)
    expect(notes).toEqual([['ok', undefined]])
  })

  it('drops a line that is longer than the cap, and reads the next one', async () => {
    const { connection, agent, say, notes, tick } = setup({ maxLineChars: 200 })
    agent.write('{"jsonrpc":"2.0","method":"big","params":"')
    agent.write('x'.repeat(150))
    agent.write('y'.repeat(150))
    agent.write('z'.repeat(150) + '"}\n')
    say({ jsonrpc: '2.0', method: 'after' })
    await tick()
    expect(notes.map(([method]) => method)).toEqual(['after'])
    expect(connection.ignored).toBeGreaterThanOrEqual(1)
  })

  it('goes on after a notification handler throws', async () => {
    let calls = 0
    const { say, tick } = setup({ onNotification: () => { calls++; throw new Error('bad') } })
    say({ jsonrpc: '2.0', method: 'a' })
    say({ jsonrpc: '2.0', method: 'b' })
    await tick()
    expect(calls).toBe(2)
  })
})

describe('asking the program', () => {
  it('writes one line per request with an id, and settles each by its id, in any order', async () => {
    const { connection, say, sent, tick } = setup()
    const first = connection.request('one', { a: 1 })
    const second = connection.request('two', { b: 2 })
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 1, method: 'one', params: { a: 1 } }, { jsonrpc: '2.0', id: 2, method: 'two', params: { b: 2 } }])
    say({ jsonrpc: '2.0', id: 2, result: 'second' })
    say({ jsonrpc: '2.0', id: 1, result: 'first' })
    await tick()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('turns an error answer into an error with its code, message and data', async () => {
    const { connection, say } = setup()
    const asked = connection.request('x', {})
    say({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Authentication required', data: { why: 'no token' } } })
    const error = await asked.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AcpRequestError)
    expect(error).toMatchObject({ code: -32000, message: 'Authentication required', data: { why: 'no token' } })
  })

  it('gives a malformed error answer a code and a message', async () => {
    const { connection, say } = setup()
    const asked = connection.request('thing', {})
    say({ jsonrpc: '2.0', id: 1, error: {} })
    expect(await asked.catch((caught: unknown) => caught)).toMatchObject({ code: RPC_ERROR.internal, message: 'thing failed.' })
  })

  it('stops waiting after the time it was given, and ignores the answer that comes later', async () => {
    const { connection, say, tick } = setup()
    const asked = connection.request('slow', {}, 20)
    const error = await asked.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AcpTimeoutError)
    expect((error as AcpTimeoutError).method).toBe('slow')
    say({ jsonrpc: '2.0', id: 1, result: 'late' })
    await tick()
    expect(connection.ignored).toBe(0)
  })

  it('does not wait at all without a time', async () => {
    const { connection, say, tick } = setup()
    const asked = connection.request('long', {})
    let settled = false
    void asked.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(settled).toBe(false)
    say({ jsonrpc: '2.0', id: 1, result: 1 })
    await tick()
    expect(settled).toBe(true)
  })

  it('tells the program something without waiting for it', () => {
    const { connection, sent } = setup()
    connection.notify('session/cancel', { sessionId: 's' })
    expect(sent()).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }])
  })
})

describe('serving what the program asks', () => {
  it('answers with the result, whatever the id was', async () => {
    const { say, sent, tick } = setup({ onRequest: async (method, params) => ({ method, params }) })
    say({ jsonrpc: '2.0', id: 0, method: 'zero', params: { a: 1 } })
    say({ jsonrpc: '2.0', id: 'abc', method: 'text' })
    await tick()
    expect(sent()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { method: 'zero', params: { a: 1 } } },
      { jsonrpc: '2.0', id: 'abc', result: { method: 'text' } }
    ])
  })

  it('answers a request that is not understood with an error instead of leaving it waiting', async () => {
    const { say, sent, tick } = setup()
    say({ jsonrpc: '2.0', id: 7, method: 'terminal/create', params: {} })
    await tick()
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: terminal/create' } }])
  })

  it('answers with an error that says nothing about why when the handler broke', async () => {
    const { say, sent, tick } = setup({ onRequest: async () => { throw new Error('C:\\secret\\path exploded') } })
    say({ jsonrpc: '2.0', id: 9, method: 'x' })
    await tick()
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'Internal error' } }])
  })

  it('answers a null result when the handler returns nothing', async () => {
    const { say, sent, tick } = setup({ onRequest: async () => undefined })
    say({ jsonrpc: '2.0', id: 3, method: 'x' })
    await tick()
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 3, result: null }])
  })
})

describe('when the program is gone', () => {
  it('fails what is waiting with the reason, and everything asked afterwards', async () => {
    const { connection, sent } = setup()
    const waiting = connection.request('x', {})
    const reason = new AcpClosedError('The program ended.', 3)
    connection.close(reason)
    await expect(waiting).rejects.toBe(reason)
    await expect(connection.request('y', {})).rejects.toBe(reason)
    expect(connection.closed).toBe(true)
    connection.notify('late', {})
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 1, method: 'x', params: {} }])
  })

  it('keeps the first reason', async () => {
    const { connection } = setup()
    const first = new AcpClosedError('first')
    connection.close(first)
    connection.close(new AcpClosedError('second'))
    await expect(connection.request('x', {})).rejects.toBe(first)
  })

  it('does not throw when the input is closed or written to after the end', async () => {
    const { connection, toAgent } = setup()
    toAgent.destroy()
    const asked = connection.request('x', {})
    connection.notify('y', {})
    connection.close(new AcpClosedError('gone'))
    await expect(asked).rejects.toBeInstanceOf(AcpClosedError)
  })
})
