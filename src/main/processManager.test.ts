import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ProcessManager,
  detectReadyHint,
  OutputBuffer,
  HEAD_RING_BYTES,
  TAIL_RING_BYTES,
  MAX_BUFFERED_EXITED_PER_CONVERSATION,
  MAX_TASK_INPUT_CHARS,
  WINDOWS_INTERRUPT_UNSUPPORTED
} from './processManager'
import { ShellCommandTooLongError, resolveShell } from './shell/shellProvider'
import type { BackgroundTask } from '@shared/ipc'

describe('OutputBuffer', () => {
  const write = (buf: OutputBuffer, text: string): void => { buf.write(Buffer.from(text, 'utf8')) }

  it('keeps the whole stream when head and tail rings cover it', () => {
    const buf = new OutputBuffer()
    const total = HEAD_RING_BYTES + TAIL_RING_BYTES
    write(buf, 'x'.repeat(total))

    const out = buf.format()
    expect(out).not.toContain('truncated')
    expect(Buffer.byteLength(out, 'utf8')).toBe(total)
  })

  it('keeps the whole stream just above the tail ring', () => {
    const buf = new OutputBuffer()
    const total = TAIL_RING_BYTES + 1_000
    write(buf, 'y'.repeat(total))

    const out = buf.format()
    expect(out).not.toContain('truncated')
    expect(Buffer.byteLength(out, 'utf8')).toBe(total)
  })

  it('marks how many bytes it dropped when the stream overflows both rings', () => {
    const buf = new OutputBuffer()
    const total = 200 * 1024
    write(buf, 'z'.repeat(total))

    const out = buf.format()
    const match = /\[(\d+) bytes truncated\]/.exec(out)
    expect(match).not.toBeNull()
    const dropped = Number(match![1])
    expect(dropped).toBe(total - HEAD_RING_BYTES - TAIL_RING_BYTES)
    expect(out.startsWith('z'.repeat(100))).toBe(true)
  })

  it('bounds the rings by bytes, not UTF-16 units', () => {
    const buf = new OutputBuffer()
    // Three bytes per character: a character cap would hold three times the bytes.
    write(buf, '漢'.repeat(80 * 1024))

    expect(buf.headByteLength).toBeLessThanOrEqual(HEAD_RING_BYTES)
    expect(buf.tailByteLength).toBeLessThanOrEqual(TAIL_RING_BYTES)
  })

  it('carries a multi-byte sequence split across chunks', () => {
    const buf = new OutputBuffer()
    const bytes = Buffer.from('ab漢字cd', 'utf8')
    // Cut inside the first CJK character's three bytes.
    buf.write(bytes.subarray(0, 3))
    buf.write(bytes.subarray(3))

    const out = buf.format()
    expect(out).toBe('ab漢字cd')
    expect(out).not.toContain('�')
  })

  it('marks dropped bytes when a tail read is capped', () => {
    const buf = new OutputBuffer()
    write(buf, 'q'.repeat(10_000))

    const out = buf.tailText(1_000)
    expect(out).toContain('bytes truncated')
    expect(out.endsWith('q'.repeat(100))).toBe(true)
  })
})

describe('detectReadyHint', () => {
  it('detects localhost URLs with port', () => {
    const hint = detectReadyHint('  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/')
    expect(hint).toBeDefined()
    expect(hint?.url).toBe('http://localhost:5173/')
    expect(hint?.port).toBe(5173)
  })

  it('detects 127.0.0.1 URLs', () => {
    const hint = detectReadyHint('Started dev server at http://127.0.0.1:3000')
    expect(hint).toBeDefined()
    expect(hint?.url).toBe('http://127.0.0.1:3000')
    expect(hint?.port).toBe(3000)
  })

  it('detects listening on port', () => {
    const hint = detectReadyHint('info: listening on port 8080')
    expect(hint).toBeDefined()
    expect(hint?.port).toBe(8080)
  })

  it('detects ready in lines', () => {
    const hint = detectReadyHint('ready in 350ms.')
    expect(hint).toBeDefined()
    expect(hint?.line).toContain('ready in 350ms.')
  })

  it('returns undefined for normal output', () => {
    expect(detectReadyHint('compiling source files...')).toBeUndefined()
  })

  it('does not read a look-alike host as a local server', () => {
    expect(detectReadyHint('Docs are at http://localhost.evil.example/start')).toBeUndefined()
    expect(detectReadyHint('Tunnel: http://127.0.0.1.nip.io:8080/')).toBeUndefined()
    expect(detectReadyHint('Visit http://localhost:51730000')).toBeUndefined()
  })

  it('reads an IPv6 loopback and drops the full stop that ends the sentence', () => {
    const hint = detectReadyHint('Server running at http://[::1]:3000/.')
    expect(hint?.url).toBe('http://[::1]:3000/')
    expect(hint?.port).toBe(3000)
    expect(detectReadyHint('Listening on http://localhost:8080.')?.url).toBe('http://localhost:8080')
  })

  it('reads a URL whose port is wrapped in color codes', () => {
    const hint = detectReadyHint('  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m')
    expect(hint?.url).toBe('http://localhost:5173/')
    expect(hint?.port).toBe(5173)
  })

  it('keeps a bare localhost URL without inventing a port', () => {
    const hint = detectReadyHint('Ready at http://localhost')
    expect(hint?.url).toBe('http://localhost')
    expect(hint?.port).toBeUndefined()
  })
})

describe('ProcessManager', () => {
  const pm = new ProcessManager()
  const shell = resolveShell('auto')

  afterEach(async () => {
    await pm.dispose()
  })

  it('runs a quick foreground command', async () => {
    const res = await pm.start({
      conversationId: 'c_test1',
      command: 'node -e "console.log(\'hello from process\')"',
      cwd: process.cwd(),
      spec: shell,
      background: false
    })

    expect(res.exited).toBe(true)
    expect(res.task.status).toBe('exited')
    expect(res.initialOutput).toContain('hello from process')
  })

  it('starts a background task and yields before exit', async () => {
    const res = await pm.start({
      conversationId: 'c_test2',
      command: 'node -e "console.log(\'ready on port 4000\'); setInterval(()=>{}, 1000)"',
      cwd: process.cwd(),
      spec: shell,
      background: true,
      yieldMs: 1500
    })

    expect(res.task.id).toMatch(/^p_[a-zA-Z0-9_-]{6}$/)
    expect(res.task.status).toBe('running')
    expect(res.task.readyHint?.port).toBe(4000)

    // Stop task
    const stopRes = await pm.stop(res.task.id)
    expect(stopRes.ok).toBe(true)

    const updated = pm.get(res.task.id)
    expect(updated?.status).toBe('killed')
  })

  it('enforces live task caps per conversation', async () => {
    const started: string[] = []
    try {
      for (let i = 0; i < 8; i++) {
        const res = await pm.start({
          conversationId: 'c_cap',
          command: 'node -e "setInterval(()=>{}, 1000)"',
          cwd: process.cwd(),
          spec: shell,
          background: true,
          yieldMs: 250
        })
        started.push(res.task.id)
      }

      await expect(
        pm.start({
          conversationId: 'c_cap',
          command: 'node -e "setInterval(()=>{}, 1000)"',
          cwd: process.cwd(),
          spec: shell,
          background: true,
          yieldMs: 250
        })
      ).rejects.toThrow(/Process limit reached/)
    } finally {
      await pm.deleteConversation('c_cap')
    }
  })

  it('reaps the buffers of older exited tasks but keeps the newest readable', async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_BUFFERED_EXITED_PER_CONVERSATION + 2; i++) {
      const res = await pm.start({
        conversationId: 'c_reap',
        command: `node -e "console.log('run ${i}')"`,
        cwd: process.cwd(),
        spec: shell,
        background: false
      })
      ids.push(res.task.id)
    }

    const newest = await pm.getOutput(ids[ids.length - 1]!)
    expect(newest.text).toContain(`run ${ids.length - 1}`)

    const oldest = await pm.getOutput(ids[0]!)
    expect(oldest.text).toContain('released to free memory')
    // The record itself survives, so task_list still reports the task.
    expect(pm.get(ids[0]!)?.status).toBe('exited')
  })

  it('reports that interrupt is unsupported on Windows instead of claiming success', async () => {
    const res = await pm.start({
      conversationId: 'c_interrupt',
      command: 'node -e "setInterval(()=>{}, 1000)"',
      cwd: process.cwd(),
      spec: shell,
      background: true,
      yieldMs: 250
    })

    try {
      const sent = await pm.sendInput(res.task.id, undefined, true)
      if (process.platform === 'win32') {
        expect(sent.ok).toBe(false)
        expect(sent.error).toMatch(/task_stop/)
      } else {
        expect(sent.ok).toBe(true)
      }
    } finally {
      await pm.stop(res.task.id)
    }
  })

  it('kills live tasks synchronously on the quit path and is idempotent', async () => {
    const res = await pm.start({
      conversationId: 'c_quit',
      command: 'node -e "setInterval(()=>{}, 1000)"',
      cwd: process.cwd(),
      spec: shell,
      background: true,
      yieldMs: 250
    })

    pm.disposeSync()
    expect(pm.get(res.task.id)).toBeUndefined()
    expect(res.task.status).toBe('killed')
    // A second round (window-all-closed then before-quit) must do nothing.
    pm.disposeSync()
    await pm.dispose()
  })
})

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Stop on a turn', () => {
  const shell = resolveShell('auto')
  let pm: ProcessManager

  afterEach(async () => {
    await pm.dispose()
  })

  const serve = (conversationId: string, turnId?: string) =>
    pm.start({
      conversationId,
      ...(turnId !== undefined ? { turnId } : {}),
      command: 'node -e "setInterval(()=>{}, 1000)"',
      cwd: process.cwd(),
      spec: shell,
      background: true,
      yieldMs: 250
    })

  it('ends the tasks that turn started and leaves every other task running', async () => {
    pm = new ProcessManager()
    const earlier = await serve('c_scope', 'turn-1')
    const own = await serve('c_scope', 'turn-2')
    const unowned = await serve('c_scope')
    const elsewhere = await serve('c_other', 'turn-2')

    await pm.cancelTurn('c_scope', 'turn-2')

    expect(pm.get(own.task.id)?.status).toBe('killed')
    await vi.waitFor(() => expect(alive(own.task.pid)).toBe(false))
    for (const survivor of [earlier, unowned, elsewhere]) {
      expect(pm.get(survivor.task.id)?.status).toBe('running')
      expect(alive(survivor.task.pid)).toBe(true)
    }
  })

  it('does nothing for a turn that started no task, so a dev server from an earlier turn survives', async () => {
    pm = new ProcessManager()
    const server = await serve('c_scope', 'turn-1')

    await pm.cancelTurn('c_scope', 'turn-2')

    expect(pm.get(server.task.id)?.status).toBe('running')
    expect(alive(server.task.pid)).toBe(true)
  })

  it('leaves a task that already ended with its own result', async () => {
    pm = new ProcessManager()
    const done = await pm.start({
      conversationId: 'c_scope', turnId: 'turn-2', command: 'node -e "console.log(1)"', cwd: process.cwd(), spec: shell, background: false
    })

    await pm.cancelTurn('c_scope', 'turn-2')

    expect(pm.get(done.task.id)?.status).toBe('exited')
  })

  it('is still ended by deleting the conversation, which stops every task of it and only it', async () => {
    pm = new ProcessManager()
    const first = await serve('c_scope', 'turn-1')
    const second = await serve('c_scope', 'turn-2')
    const elsewhere = await serve('c_other', 'turn-1')

    await pm.deleteConversation('c_scope')

    expect(pm.list('c_scope')).toEqual([])
    for (const gone of [first, second]) await vi.waitFor(() => expect(alive(gone.task.pid)).toBe(false))
    expect(pm.get(elsewhere.task.id)?.status).toBe('running')
  })
})

describe('task events', () => {
  const shell = resolveShell('auto')
  let pm: ProcessManager
  let seen: Array<{ task: BackgroundTask; turnId?: string }>

  const start = (command: string, options: { turnId?: string; conversationId?: string; yieldMs?: number } = {}) =>
    pm.start({
      conversationId: options.conversationId ?? 'c_events',
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      command, cwd: process.cwd(), spec: shell, background: true, yieldMs: options.yieldMs ?? 250
    })

  const setup = (): void => {
    pm = new ProcessManager()
    seen = []
    pm.subscribe((task, turnId) => seen.push({ task, ...(turnId !== undefined ? { turnId } : {}) }))
  }

  afterEach(async () => {
    await pm.dispose()
  })

  it('reports start, ready, stop and the final exit, each carrying the turn that started the task', async () => {
    setup()
    const res = await start('node -e "console.log(\'listening on port 4321\'); setInterval(()=>{}, 1000)"', { turnId: 'turn-1', yieldMs: 5000 })
    await pm.stop(res.task.id)
    await vi.waitFor(() => expect(seen.at(-1)?.task.endedAt).toBeDefined())

    expect(seen.every((event) => event.turnId === 'turn-1' && event.task.id === res.task.id)).toBe(true)
    expect(seen[0]!.task).toMatchObject({ status: 'running' })
    expect(seen[0]!.task.readyHint).toBeUndefined()
    expect(seen.some((event) => event.task.status === 'running' && event.task.readyHint?.port === 4321)).toBe(true)
    const statuses = seen.map((event) => event.task.status)
    expect(statuses.at(-1)).toBe('killed')
    // The stop is announced at once, before the process has finished dying.
    expect(statuses.indexOf('killed')).toBeLessThan(seen.findIndex((event) => event.task.endedAt !== undefined))
  })

  it('reports a command that finishes on its own with its exit code', async () => {
    setup()
    const res = await start('node -e "process.exit(3)"', { yieldMs: 5000 })
    await vi.waitFor(() => expect(seen.at(-1)?.task.status).toBe('failed'))

    expect(res.exited).toBe(true)
    expect(seen.at(-1)!.task).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(seen.at(-1)!.turnId).toBeUndefined()
  })

  it('keeps reporting after the turn that started the task is long over', async () => {
    setup()
    const res = await start('node -e "setInterval(()=>{}, 1000)"', { turnId: 'turn-that-ended' })
    seen.length = 0
    // Nothing about the turn is needed any more: the user stops it from the Tasks tab, with no turn running.
    await pm.stop(res.task.id)
    await vi.waitFor(() => expect(seen.at(-1)?.task.endedAt).toBeDefined())
    expect(seen.map((event) => event.task.status)).toEqual(['killed', 'killed'])
    expect(seen[0]!.turnId).toBe('turn-that-ended')
  })

  it('goes quiet for tasks of a deleted conversation', async () => {
    setup()
    await start('node -e "setInterval(()=>{}, 1000)"', { conversationId: 'c_gone' })
    seen.length = 0
    await pm.deleteConversation('c_gone')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen).toEqual([])
  })

  it('stops calling a listener that unsubscribed, and survives one that throws', async () => {
    pm = new ProcessManager()
    const heard: string[] = []
    const off = pm.subscribe((task) => heard.push(task.status))
    pm.subscribe(() => { throw new Error('observer bug') })
    const res = await start('node -e "setInterval(()=>{}, 1000)"')
    expect(heard).toEqual(['running'])
    off()
    await pm.stop(res.task.id)
    await vi.waitFor(() => expect(pm.get(res.task.id)?.endedAt).toBeDefined())
    expect(heard).toEqual(['running'])
  })

  it('tells observers a task hit its time limit', async () => {
    setup()
    const limited = await pm.start({
      conversationId: 'c_events', command: 'node -e "setInterval(()=>{}, 1000)"', cwd: process.cwd(), spec: shell,
      background: true, yieldMs: 5000, timeoutMs: 400
    })
    expect(limited.exited).toBe(true)
    expect(limited.task.status).toBe('timed_out')
    expect(seen.map((event) => event.task.status)).toContain('timed_out')
    expect(seen.at(-1)!.task.status).toBe('timed_out')
  })
})

describe('input and interrupt', () => {
  const shell = resolveShell('auto')
  let pm: ProcessManager

  afterEach(async () => {
    await pm.dispose()
  })

  const echo = (): ReturnType<ProcessManager['start']> =>
    pm.start({
      conversationId: 'c_input',
      command: 'node -e "process.stdin.on(\'data\', d => console.log(\'got:\' + String(d).trim())); setInterval(()=>{}, 1000)"',
      cwd: process.cwd(), spec: shell, background: true, yieldMs: 250
    })

  it('delivers a line of input to the task', async () => {
    pm = new ProcessManager()
    const res = await echo()
    expect(await pm.sendInput(res.task.id, 'hello')).toEqual({ ok: true })
    await vi.waitFor(async () => expect((await pm.getOutput(res.task.id)).text).toContain('got:hello'))
  })

  it('refuses an interrupt on Windows and sends nothing at all, not even the text that came with it', async () => {
    pm = new ProcessManager(undefined, { platform: 'win32' })
    const res = await echo()

    const refused = await pm.sendInput(res.task.id, 'typed after the interrupt', true)

    expect(refused).toEqual({ ok: false, error: WINDOWS_INTERRUPT_UNSUPPORTED })
    expect(refused.error).toContain('Nothing was sent')
    expect(refused.error).toContain('task_stop')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await pm.getOutput(res.task.id)).text).not.toContain('got:')
    expect(pm.get(res.task.id)?.status).toBe('running')
    // Plain input still works on the same task.
    expect((await pm.sendInput(res.task.id, 'still here')).ok).toBe(true)
    await vi.waitFor(async () => expect((await pm.getOutput(res.task.id)).text).toContain('got:still here'))
  })

  it.skipIf(process.platform === 'win32')('interrupts the whole process group on POSIX', async () => {
    pm = new ProcessManager()
    const res = await pm.start({
      conversationId: 'c_input',
      command: 'node -e "process.on(\'SIGINT\', () => { console.log(\'got sigint\'); process.exit(0) }); setInterval(()=>{}, 1000)"',
      cwd: process.cwd(), spec: shell, background: true, yieldMs: 500
    })
    expect(await pm.sendInput(res.task.id, undefined, true)).toEqual({ ok: true })
    await vi.waitFor(() => expect(pm.get(res.task.id)?.status).toBe('exited'))
    expect((await pm.getOutput(res.task.id)).text).toContain('got sigint')
  })

  it('does not write a runaway paste', async () => {
    pm = new ProcessManager()
    const res = await echo()
    const refused = await pm.sendInput(res.task.id, 'x'.repeat(MAX_TASK_INPUT_CHARS + 1))
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('Nothing was sent')
    expect((await pm.sendInput(res.task.id, 'x'.repeat(MAX_TASK_INPUT_CHARS))).ok).toBe(true)
  })

  it('says so when the task is gone or has ended', async () => {
    pm = new ProcessManager()
    expect(await pm.sendInput('p_nope', 'hi')).toEqual({ ok: false, error: 'Task p_nope not found.' })
    const done = await pm.start({ conversationId: 'c_input', command: 'node -e "1"', cwd: process.cwd(), spec: shell, background: false })
    expect(await pm.sendInput(done.task.id, 'hi')).toEqual({ ok: false, error: `Task ${done.task.id} is not running.` })
  })
})

describe('starting a command that cannot start', () => {
  it('closes its saved output instead of leaving it running', async () => {
    const writer = {
      id: 'out-1',
      artifact: {},
      append: vi.fn(),
      finish: vi.fn()
    }
    const pm = new ProcessManager({ create: () => writer as never })
    const tooLong = { ...resolveShell('auto'), argv: () => { throw new ShellCommandTooLongError('Command Prompt', 8_000) } }

    await expect(pm.start({
      conversationId: 'c_fail', command: 'x', cwd: process.cwd(), spec: tooLong, background: true
    })).rejects.toThrow(/too long/)

    expect(writer.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: expect.stringContaining('too long') }))
    expect(pm.list('c_fail')).toEqual([])
  })
})
