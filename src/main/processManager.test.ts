import { describe, it, expect, afterEach, vi } from 'vitest'
import { ProcessManager, detectReadyHint, OutputBuffer, HEAD_RING_BYTES, TAIL_RING_BYTES, WINDOWS_INTERRUPT_UNSUPPORTED } from './processManager'
import { resolveShell } from './shell/shellProvider'
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
})

describe('detectReadyHint', () => {
  it('detects localhost URLs with port', () => {
    const hint = detectReadyHint('  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/')
    expect(hint).toBeDefined()
    expect(hint?.url).toBe('http://localhost:5173/')
    expect(hint?.port).toBe(5173)
  })

  it('detects listening on port', () => {
    const hint = detectReadyHint('info: listening on port 8080')
    expect(hint).toBeDefined()
    expect(hint?.port).toBe(8080)
  })

  it('does not read a look-alike host as a local server', () => {
    expect(detectReadyHint('Docs are at http://localhost.evil.example/start')).toBeUndefined()
    expect(detectReadyHint('Tunnel: http://127.0.0.1.nip.io:8080/')).toBeUndefined()
    expect(detectReadyHint('Visit http://localhost:51730000')).toBeUndefined()
  })
})

describe('ProcessManager', () => {
  const pm = new ProcessManager()
  const shell = resolveShell('auto')

  afterEach(async () => {
    await pm.dispose()
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
})
