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
})
