import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '../../../shared/ipc'
import {
  MAX_TASK_RECORDS, formatRuntime, lastLine, mergeTask, mergeTasks, readyTarget, runningCount, runtimeMs, shellName, sortTasks,
  statusLine, tailLines, tailPath, taskState
} from './taskModel'

const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'p_aaaaaa', conversationId: 'c1', command: 'npm run dev', shell: 'git-bash', cwd: 'C:\\code\\app', status: 'running',
  startedAt: 1_000, outputId: 'out-1', ...overrides
})

describe('task state and wording', () => {
  it('maps every status to one state', () => {
    expect(['running', 'exited', 'failed', 'timed_out', 'killed'].map((status) => taskState(task({ status: status as BackgroundTask['status'] })))).toEqual(
      ['running', 'done', 'failed', 'timed_out', 'stopped']
    )
  })

  it('says what each task ended with, and gives a stopped task no exit code', () => {
    expect(statusLine(task(), 5_000)).toBe('Running')
    expect(statusLine(task({ status: 'exited', exitCode: 0 }), 5_000)).toBe('Finished')
    expect(statusLine(task({ status: 'exited', exitCode: 3 }), 5_000)).toBe('Exited with code 3')
    expect(statusLine(task({ status: 'failed', exitCode: 2 }), 5_000)).toBe('Failed with exit code 2')
    expect(statusLine(task({ status: 'failed' }), 5_000)).toBe('Failed to run')
    expect(statusLine(task({ status: 'killed', exitCode: 1 }), 5_000)).toBe('Stopped')
    expect(statusLine(task({ status: 'timed_out', exitCode: 1, startedAt: 0, endedAt: 30 * 60_000 }), 99)).toBe('Reached its time limit after 30m 00s')
  })

  it('names the shells', () => {
    expect(shellName('git-bash')).toBe('Git Bash')
    expect(shellName('powershell')).toBe('Windows PowerShell')
  })
})

describe('runtime', () => {
  it('runs until now while the task runs and stops at its end afterwards', () => {
    expect(runtimeMs(task({ startedAt: 1_000 }), 4_500)).toBe(3_500)
    expect(runtimeMs(task({ startedAt: 1_000, endedAt: 2_000, status: 'exited' }), 90_000)).toBe(1_000)
    expect(runtimeMs(task({ startedAt: 5_000 }), 1_000)).toBe(0)
  })

  it.each([
    [0, '0s'], [999, '0s'], [8_400, '8s'], [59_999, '59s'], [60_000, '1m 00s'], [134_000, '2m 14s'], [3_599_000, '59m 59s'],
    [3_900_000, '1h 05m'], [7_320_000, '2h 02m'], [-5, '0s']
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatRuntime(ms)).toBe(text)
  })
})

describe('ordering and merging', () => {
  it('lists running tasks first, each group newest first', () => {
    const sorted = sortTasks([
      task({ id: 'old-done', status: 'exited', startedAt: 10 }),
      task({ id: 'old-run', startedAt: 20 }),
      task({ id: 'new-done', status: 'failed', startedAt: 90 }),
      task({ id: 'new-run', startedAt: 80 })
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['new-run', 'old-run', 'new-done', 'old-done'])
  })

  it('does not let a late running snapshot bring an ended task back', () => {
    const ended = task({ status: 'killed', endedAt: 9_000 })
    expect(mergeTask(ended, task({ status: 'running' }))).toBe(ended)
  })

  it('keeps the snapshot that knows when a finished task ended', () => {
    const withEnd = task({ status: 'killed', endedAt: 9_000 })
    expect(mergeTask(withEnd, task({ status: 'killed' }))).toBe(withEnd)
    expect(mergeTask(task({ status: 'killed' }), withEnd)).toBe(withEnd)
  })

  it('keeps a ready address once it was seen', () => {
    const ready = task({ readyHint: { url: 'http://localhost:5173/', port: 5173, line: 'Local: http://localhost:5173/' } })
    expect(mergeTask(ready, task()).readyHint).toEqual(ready.readyHint)
    expect(mergeTask(undefined, task())).toEqual(task())
  })

  it('folds a batch into a conversation and drops only the oldest finished tasks past the cap', () => {
    const finished = Array.from({ length: MAX_TASK_RECORDS + 5 }, (_, index) => task({ id: `done-${index}`, status: 'exited', startedAt: index }))
    const merged = mergeTasks([task({ id: 'still-running', startedAt: -1 })], finished)
    expect(merged).toHaveLength(MAX_TASK_RECORDS)
    expect(merged[0]!.id).toBe('still-running')
    expect(merged.some((entry) => entry.id === 'done-0')).toBe(false)
    expect(merged.some((entry) => entry.id === `done-${MAX_TASK_RECORDS + 4}`)).toBe(true)
  })

  it('counts what is running', () => {
    expect(runningCount([task(), task({ id: 'b', status: 'exited' }), task({ id: 'c' })])).toBe(2)
    expect(runningCount(undefined)).toBe(0)
  })
})

describe('the address a ready line points at', () => {
  const hint = (url?: string, port?: number, line = 'ready'): BackgroundTask['readyHint'] => ({ ...(url ? { url } : {}), ...(port !== undefined ? { port } : {}), line })

  it('opens a plain address on this computer', () => {
    expect(readyTarget(hint('http://localhost:5173/', 5173))).toEqual({ kind: 'url', href: 'http://localhost:5173/', label: 'localhost:5173' })
    expect(readyTarget(hint('http://127.0.0.1:3000/api/docs?x=1'))).toMatchObject({ kind: 'url', label: '127.0.0.1:3000/api/docs?x=1' })
    expect(readyTarget(hint('http://[::1]:8080/'))).toMatchObject({ kind: 'url', label: '[::1]:8080' })
  })

  it('opens a server that listens on every interface as localhost', () => {
    expect(readyTarget(hint('http://0.0.0.0:8080/'))).toEqual({ kind: 'url', href: 'http://localhost:8080/', label: 'localhost:8080' })
  })

  it('never makes a link out of anything else a process printed', () => {
    for (const url of ['http://localhost.evil.example/', 'https://example.com/', 'javascript:alert(1)', 'file:///C:/secret', 'ftp://localhost/', 'http://user:pw@localhost:3000/', 'not a url']) {
      expect(readyTarget(hint(url, undefined, 'Docs at somewhere'))?.kind, url).toBe('line')
    }
  })

  it('shows a bare port or the line itself as text', () => {
    expect(readyTarget(hint(undefined, 8080, 'listening on port 8080'))).toEqual({ kind: 'port', label: 'Port 8080' })
    expect(readyTarget(hint(undefined, undefined, 'ready in 350 ms'))).toEqual({ kind: 'line', label: 'ready in 350 ms' })
    expect(readyTarget(undefined)).toBeUndefined()
  })
})

describe('terminal output as lines', () => {
  it('drops escape codes and keeps the text', () => {
    expect(tailLines('  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   http://localhost:5173/\n')).toEqual(['  ➜  Local:   http://localhost:5173/'])
  })

  it('settles a progress line that redraws itself with carriage returns', () => {
    expect(tailLines('Seeding 10%\rSeeding 40%\rSeeding 100%\nnext\r\nlast\r\n')).toEqual(['Seeding 100%', 'next', 'last'])
    expect(tailLines('partial\r')).toEqual(['partial'])
  })

  it('keeps only the newest lines and drops the final empty one', () => {
    const raw = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n') + '\n'
    const lines = tailLines(raw, 300)
    expect(lines).toHaveLength(300)
    expect(lines[0]).toBe('line 200')
    expect(lines.at(-1)).toBe('line 499')
    expect(tailLines('')).toEqual([])
  })

  it('finds the newest line that says something', () => {
    expect(lastLine('first\nsecond\n\n   \n')).toBe('second')
    expect(lastLine('')).toBe('')
    expect(lastLine(`${'x'.repeat(400)}\n`, 50)).toBe(`${'x'.repeat(49)}…`)
  })
})

describe('paths', () => {
  it('keeps the last folders where the whole path will not fit', () => {
    expect(tailPath('C:\\Users\\dev\\code\\lumen-web')).toBe('…\\code\\lumen-web')
    expect(tailPath('/home/h/code/app')).toBe('…/code/app')
    expect(tailPath('C:\\code')).toBe('C:\\code')
  })
})
