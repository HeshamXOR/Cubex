import { describe, expect, it, vi } from 'vitest'
import { openSignIn, signInPlan } from './signIn'

describe('signInPlan', () => {
  it('opens a console that runs the program with its arguments and stays open', () => {
    const plan = signInPlan('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', ['auth', 'login'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(plan).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"start "Cubex sign-in" cmd.exe /d /v:off /k ""C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" auth login""'],
      windowsVerbatimArguments: true
    })
  })

  it('quotes a path with spaces and parentheses', () => {
    const plan = signInPlan('C:\\Program Files (x86)\\Tool\\codex.exe', ['login'], { ComSpec: 'cmd.exe' })
    expect('args' in plan && plan.args[4]).toContain('""C:\\Program Files (x86)\\Tool\\codex.exe" login"')
  })

  it('runs a program without arguments', () => {
    const plan = signInPlan('C:\\bin\\tool.exe', [], { ComSpec: 'cmd.exe' })
    expect('args' in plan && plan.args[4]).toContain('/k ""C:\\bin\\tool.exe""')
  })

  it('falls back to the system folder when no shell is named', () => {
    const plan = signInPlan('C:\\bin\\tool.exe', [], { SystemRoot: 'D:\\Win' })
    expect('file' in plan && plan.file).toBe('D:\\Win\\System32\\cmd.exe')
  })

  it.each(['C:\\a"b\\tool.exe', 'C:\\100%\\tool.exe', 'C:\\a^b\\tool.exe', 'C:\\a!b\\tool.exe', 'C:\\a\nb\\tool.exe'])('refuses a path cmd.exe would reinterpret: %j', (path) => {
    expect(signInPlan(path, ['login'], {})).toHaveProperty('error')
  })

  it('refuses an argument it cannot quote', () => {
    expect(signInPlan('C:\\bin\\tool.exe', ['a"b'], {})).toHaveProperty('error')
  })
})

describe('openSignIn', () => {
  const env = { ComSpec: 'cmd.exe' }

  it('opens the window, detached, and does not wait for it', () => {
    const unref = vi.fn()
    const start = vi.fn(() => ({ on: vi.fn(), unref })) as never
    const result = openSignIn({ program: 'C:\\bin\\claude.exe', args: ['auth', 'login'], env, typed: 'claude auth login', platform: 'win32', start })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Finish signing in there')
    expect(result.message).toContain('checks again')
    expect(start).toHaveBeenCalledTimes(1)
    const call = (start as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(call[2]).toMatchObject({ detached: true, stdio: 'ignore', shell: false, windowsVerbatimArguments: true })
    expect(unref).toHaveBeenCalled()
  })

  it('says what to run when the platform has no window to open', () => {
    const start = vi.fn()
    const result = openSignIn({ program: '/usr/bin/claude', args: ['auth', 'login'], env, typed: 'claude auth login', platform: 'darwin', start: start as never })
    expect(result).toEqual({ ok: false, message: expect.stringContaining('claude auth login') })
    expect(start).not.toHaveBeenCalled()
  })

  it('says what to run when the path cannot be quoted', () => {
    const start = vi.fn()
    const result = openSignIn({ program: 'C:\\100%\\claude.exe', args: ['auth', 'login'], env, typed: 'claude auth login', platform: 'win32', start: start as never })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('claude auth login')
    expect(start).not.toHaveBeenCalled()
  })

  it('says why when the window could not be opened', () => {
    const start = vi.fn(() => { throw new Error('spawn EACCES') }) as never
    const result = openSignIn({ program: 'C:\\bin\\claude.exe', args: ['auth', 'login'], env, typed: 'claude auth login', platform: 'win32', start })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('EACCES')
    expect(result.message).toContain('claude auth login')
  })
})
