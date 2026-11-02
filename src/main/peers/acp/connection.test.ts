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
})
