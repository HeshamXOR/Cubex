import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { HookTestResult } from '@shared/policy'

const mocks = vi.hoisted(() => ({ testHook: vi.fn() }))
vi.mock('../hooks', () => ({ testHook: mocks.testHook }))

import { register } from './hooks'

const result = (over: Partial<HookTestResult> = {}): HookTestResult => ({
  event: 'PreToolUse', command: 'x', cwd: 'C:\\p', cwdKind: 'project', payload: '{}', outcome: 'ran', exitCode: 0,
  durationMs: 5, stdout: '', stderr: '', truncated: false, decision: 'allowed', ...over
})

let workspace: string | undefined
let handler: (request: unknown) => Promise<HookTestResult>
const channels: string[] = []

beforeEach(() => {
  workspace = 'C:\\proj'
  channels.length = 0
  mocks.testHook.mockReset().mockResolvedValue(result())
  register({
    handle: (channel: string, fn: (...args: never[]) => unknown) => { channels.push(channel); handler = fn as typeof handler },
    taskWorkspace: () => workspace
  } as never)
})

describe('hooks:test', () => {
  it('declares exactly its one channel while registering', () => {
    expect(channels).toEqual([IPC.hooksTest])
  })

  it.each([
    undefined, null, 'npm run format', 7, [],
    {},
    { event: 'PreToolUse' },
    { event: 'PreToolUse', command: '   ' },
    { event: 'OnSave', command: 'x' },
    { event: 'PreToolUse', command: 'x', matcher: 'write_*' },
    { event: 'PreToolUse', command: 'x', matcher: 4 },
    { event: 'PreToolUse', command: 'a'.repeat(5_000) },
    { event: 'PreToolUse', command: 'a\0b' }
  ])('rejects a malformed request without running anything: %j', async (request) => {
    await expect(handler(request)).rejects.toThrow()
    expect(mocks.testHook).not.toHaveBeenCalled()
  })

  it('runs the validated hook in the selected project', async () => {
    await handler({ event: 'PostToolUse', matcher: ' write_file ', command: ' npm run format ', enabled: true, id: 'h1' })
    expect(mocks.testHook).toHaveBeenCalledWith({ event: 'PostToolUse', matcher: 'write_file', command: 'npm run format' }, { workspace: 'C:\\proj' })
  })

  it('passes no workspace when no project is selected', async () => {
    workspace = undefined
    await handler({ event: 'Stop', command: 'x' })
    expect(mocks.testHook).toHaveBeenCalledWith({ event: 'Stop', command: 'x' }, { workspace: undefined })
  })

  it('refuses a fourth test at once, and frees the slot when one fails', async () => {
    const release: Array<() => void> = []
    mocks.testHook.mockImplementation(() => new Promise<HookTestResult>((resolve) => { release.push(() => resolve(result())) }))
    const running = [1, 2, 3].map(() => handler({ event: 'Stop', command: 'x' }))
    await expect(handler({ event: 'Stop', command: 'x' })).rejects.toThrow('Other hook tests are still running.')
    release.forEach((done) => done())
    await Promise.all(running)

    mocks.testHook.mockRejectedValue(new Error('boom'))
    for (let i = 0; i < 5; i++) await expect(handler({ event: 'Stop', command: 'x' })).rejects.toThrow('boom')
  })
})
