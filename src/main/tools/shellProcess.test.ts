import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminateShellTree } from './shellProcess'
import { createShellTool } from './shellTool'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

function childFixture(pid = 1234): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  }) as unknown as ChildProcess
}

describe('shell process-tree termination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses a hidden Windows tree-kill process with literal PID arguments', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    expect(spawnMock).toHaveBeenCalledWith('taskkill.exe', ['/PID', '1234', '/T', '/F'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    killer.emit('close', 0)
    expect(await result).toBeUndefined()
    expect(shell.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports OS denial and falls back to stopping the shell', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    killer.stderr!.emit('data', Buffer.from('ERROR: Access is denied.'))
    killer.emit('close', 1)
    expect(await result).toContain('Access is denied')
    expect(shell.kill).toHaveBeenCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats a process that ended on its own while the tree was being stopped as stopped', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    killer.stdout!.emit('data', Buffer.from([
      'SUCCESS: The process with PID 22724 (child process of PID 8252) has been terminated.',
      'ERROR: The process with PID 23224 (child process of PID 7164) could not be terminated.',
      'Reason: There is no running instance of the task.',
      ''
    ].join('\r\n')))
    killer.emit('close', 255)
    expect(await result).toBeUndefined()
    expect(shell.kill).not.toHaveBeenCalled()
  })

  it('still reports a process that could not be stopped for any other reason', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    killer.stdout!.emit('data', Buffer.from([
      'ERROR: The process with PID 23224 (child process of PID 7164) could not be terminated.',
      'Reason: There is no running instance of the task.',
      'ERROR: The process with PID 22724 (child process of PID 8252) could not be terminated.',
      'Reason: Access is denied.',
      ''
    ].join('\r\n')))
    killer.emit('close', 255)
    expect(await result).toContain('Access is denied')
    expect(shell.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('cleans up when Windows taskkill cannot start', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    killer.emit('error', new Error('spawn ENOENT'))
    killer.emit('close', null)
    expect(await result).toContain('spawn ENOENT')
    expect(shell.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a hung Windows taskkill and reports that termination is incomplete', async () => {
    const shell = childFixture()
    const killer = childFixture(5678)
    spawnMock.mockReturnValue(killer)
    const result = terminateShellTree(shell, 'win32')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toContain('did not finish within 5 seconds')
    expect(killer.kill).toHaveBeenCalled()
    expect(shell.kill).toHaveBeenCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminates the entire detached POSIX process group', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const shell = childFixture()
    expect(await terminateShellTree(shell, 'linux')).toBeUndefined()
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGKILL')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(shell.kill).not.toHaveBeenCalled()
  })

  it('accepts a POSIX process group that already exited', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const shell = childFixture()
    expect(await terminateShellTree(shell, 'darwin')).toBeUndefined()
    expect(shell.kill).not.toHaveBeenCalled()
  })

  it('reports failure to stop a POSIX group and attempts to stop its shell', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    const shell = childFixture()
    expect(await terminateShellTree(shell, 'linux')).toContain('Could not terminate the process group: denied')
    expect(shell.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a signal exit as a command failure and releases the abort listener', async () => {
    const shell = childFixture()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    spawnMock.mockReturnValue(shell)
    const execution = createShellTool(process.cwd()).execute({ command: 'fixture' }, {
      signal: controller.signal,
      requestPermission: async () => ({ decision: 'allow' })
    })
    shell.emit('spawn')
    shell.emit('close', null, 'SIGTERM')
    const result = await execution
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Command terminated by signal: SIGTERM')
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invent a successful exit code when the shell closes without a status', async () => {
    const shell = childFixture()
    spawnMock.mockReturnValue(shell)
    const execution = createShellTool(process.cwd()).execute({ command: 'fixture' }, {
      requestPermission: async () => ({ decision: 'allow' })
    })
    shell.emit('spawn')
    shell.emit('close', null, null)
    const result = await execution
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Command exited without an exit code.')
    expect(vi.getTimerCount()).toBe(0)
  })
})
