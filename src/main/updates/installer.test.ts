import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { INSTALLER_ARGUMENTS, installSupport, startInstaller } from './installer'

const INSTALLED = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Cubex\\Cubex.exe'

describe('installSupport', () => {
  it('lets a Windows copy that the installer set up replace itself', () => {
    const asked: string[] = []
    const support = installSupport({ platform: 'win32', packaged: true, execPath: INSTALLED }, (path) => { asked.push(path); return true })
    expect(support).toEqual({ canInstall: true })
    // The uninstaller sits beside the executable; an unpacked folder or a portable copy has none.
    expect(asked).toEqual(['C:\\Users\\dev\\AppData\\Local\\Programs\\Cubex\\Uninstall Cubex.exe'])
  })

  it('does not let an unpacked or portable Windows copy do it, and says what to do', () => {
    const support = installSupport({ platform: 'win32', packaged: true, execPath: 'F:\\Apps\\Cubex\\win-unpacked\\Cubex.exe' }, () => false)
    expect(support.canInstall).toBe(false)
    expect(support.reason).toMatch(/not set up with the Cubex installer/)
    expect(support.reason).toMatch(/release page/)
  })

  it('does not let a copy run from source do it', () => {
    const support = installSupport({ platform: 'win32', packaged: false, execPath: 'C:\\node_modules\\electron\\dist\\electron.exe' }, () => true)
    expect(support).toEqual({ canInstall: false, reason: 'This copy runs from source, so it cannot update itself.' })
  })

  it.each<NodeJS.Platform>(['darwin', 'linux'])('does not run a Windows installer on %s', (platform) => {
    const support = installSupport({ platform, packaged: true, execPath: '/opt/Cubex/cubex' }, () => true)
    expect(support.canInstall).toBe(false)
    expect(support.reason).toMatch(/Windows only/)
  })
})

describe('INSTALLER_ARGUMENTS', () => {
  it('are the three flags electron-builder\'s installer reads for a silent update that starts the app again', () => {
    expect([...INSTALLER_ARGUMENTS]).toEqual(['--updated', '/S', '--force-run'])
  })
})

describe('startInstaller', () => {
  function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { unref: vi.fn() })
  }

  it('starts the installer apart from Cubex with the update flags, and resolves once it has started', async () => {
    const child = fakeChild()
    const spawnImpl = vi.fn(() => child)
    const started = startInstaller('C:\\data\\updates\\Cubex-Setup-0.2.0.exe', spawnImpl as never)
    expect(spawnImpl).toHaveBeenCalledWith('C:\\data\\updates\\Cubex-Setup-0.2.0.exe', ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
    // Nothing has resolved before the process really exists, so Cubex stays open if it never does.
    let done = false
    void started.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(child.unref).not.toHaveBeenCalled()
    child.emit('spawn')
    await started
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the installer cannot be started', async () => {
    const child = fakeChild()
    const started = startInstaller('C:\\data\\Cubex-Setup.exe', (() => child) as never)
    child.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }))
    await expect(started).rejects.toThrow('spawn UNKNOWN')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('rejects when starting throws at once, as it does for a path that does not exist', async () => {
    await expect(startInstaller('x', (() => { throw new Error('ENOENT') }) as never)).rejects.toThrow('ENOENT')
  })

  it('does not let an error after the start take Cubex down', async () => {
    const child = fakeChild()
    const started = startInstaller('x', (() => child) as never)
    child.emit('spawn')
    await started
    expect(() => child.emit('error', new Error('late'))).not.toThrow()
  })
})
