import type { Readable, Writable } from 'node:stream'

/**
 * The JSON-RPC 2.0 half of the Agent Client Protocol over a program's standard input and output: one message per line,
 * nothing else on either stream that matters. This knows nothing about agents. It frames and parses lines, matches
 * answers to requests, serves the requests the program makes of Cubex, and fails everything that waits when the
 * program is gone.
 *
 * A program can print what it likes, so nothing it sends is trusted: a line that is not a message is counted and
 * dropped, a line that never ends is dropped when it passes the cap, and a request that is not understood is answered
 * with an error instead of being left waiting.
 */

/** The error codes of JSON-RPC, and the one the protocol adds for an agent that needs the person to sign in. */
export const RPC_ERROR = { parse: -32700, invalidParams: -32602, methodNotFound: -32601, internal: -32603, authRequired: -32000 } as const

/** An error answer: one the program sent for a request of ours, or one we send for a request of the program's. */
export class AcpRequestError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'AcpRequestError'
  }
}

/** The program ended, or was stopped, while a request waited for its answer. */
export class AcpClosedError extends Error {
  /** `exitCode` is how the program ended; `errno` is why it could not start, such as ENOENT. */
  constructor(message: string, readonly exitCode?: number | null, readonly errno?: string) {
    super(message)
    this.name = 'AcpClosedError'
  }
}

/** A request got no answer within the time it was given. */
export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`No answer to ${method} within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`)
    this.name = 'AcpTimeoutError'
  }
}

/** One line may be a long tool output; anything past this is not a message anyone will read. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024

export interface AcpConnectionOptions {
  /** A notification from the program. Whatever it throws is ignored. */
  onNotification: (method: string, params: unknown) => void
  /** A request from the program. Resolve with the result; throw an AcpRequestError to answer with an error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>
  maxLineChars?: number
}

interface Pending {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class AcpConnection {
  private buffer = ''
  private discarding = false
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private reason: Error | undefined
  private readonly maxLine: number
  /** Lines that were not messages: a warning printed to the wrong stream, or a line past the cap. */
  ignored = 0

  constructor(input: Readable, private readonly output: Writable, private readonly options: AcpConnectionOptions) {
    this.maxLine = options.maxLineChars ?? MAX_LINE_CHARS
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.read(chunk))
    // The program closing a pipe is reported by its exit, not by an error here.
    input.on('error', () => undefined)
    output.on('error', () => undefined)
  }

  get closed(): boolean {
    return this.reason !== undefined
  }

  /** Ask the program something. Without a time, the answer is waited for until the program ends. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.reason) return Promise.reject(this.reason)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject }
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new AcpTimeoutError(method, timeoutMs))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Tell the program something that needs no answer. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** The program is gone: whatever waited for it fails with this, and nothing more is sent. */
  close(reason: Error): void {
    if (this.reason) return
    this.reason = reason
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }

  private write(message: unknown): void {
    if (this.reason) return
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The pipe is closed: the program's exit reports it.
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      // The rest of a line that was already too long is not a message.
      if (this.discarding) this.discarding = false
      else this.line(line)
    }
    if (this.buffer.length > this.maxLine) {
      this.buffer = ''
      this.discarding = true
      this.ignored++
    }
  }

  private line(raw: string): void {
    const text = raw.trim()
    if (!text) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.ignored++
      return
    }
    if (!isRecord(message)) {
      this.ignored++
      return
    }
    const { id, method } = message
    const hasId = typeof id === 'number' || typeof id === 'string'
    if (typeof method === 'string') {
      if (hasId) void this.serve(id, method, message.params)
      else this.notification(method, message.params)
      return
    }
    if (hasId && ('result' in message || 'error' in message)) {
      this.settle(id, message)
      return
    }
    this.ignored++
  }

  private notification(method: string, params: unknown): void {
    try {
      this.options.onNotification(method, params)
    } catch {
      // A bad notification must not take the connection with it.
    }
  }

  private settle(id: number | string, message: Record<string, unknown>): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    const error = message.error
    if (isRecord(error)) {
      const code = typeof error.code === 'number' ? error.code : RPC_ERROR.internal
      const text = typeof error.message === 'string' && error.message ? error.message : `${entry.method} failed.`
      entry.reject(new AcpRequestError(code, text, error.data))
    } else {
      entry.resolve(message.result)
    }
  }

  private async serve(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      const known = error instanceof AcpRequestError ? error : new AcpRequestError(RPC_ERROR.internal, 'Internal error')
      this.write({ jsonrpc: '2.0', id, error: { code: known.code, message: known.message, ...(known.data !== undefined ? { data: known.data } : {}) } })
    }
  }
}
