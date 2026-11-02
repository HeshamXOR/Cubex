import { describe, expect, it } from 'vitest'
import { expandPathEntries, parseRegistryPath, registryPath, toolDirectories, withExtraPath } from './environment'

describe('parseRegistryPath', () => {
  it('reads the value of Path from what reg query prints', () => {
    const output = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\me\\bin;%USERPROFILE%\\.local\\bin\r\n\r\n'
    expect(parseRegistryPath(output)).toBe('C:\\Users\\me\\bin;%USERPROFILE%\\.local\\bin')
  })
})

describe('expandPathEntries', () => {
  it('replaces variables, whatever their case', () => {
    expect(expandPathEntries('%UserProfile%\\bin;%systemroot%\\system32', { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' }))
      .toEqual(['C:\\Users\\me\\bin', 'C:\\Windows\\system32'])
  })
})

describe('registryPath', () => {
  it('puts the user entries first and the machine ones after', () => {
    const read = (key: string): string | undefined => (key.startsWith('HKCU') ? 'C:\\user\\bin' : 'C:\\machine\\bin;%WINDIR%\\system32')
    expect(registryPath({ WINDIR: 'C:\\Windows' }, read)).toEqual(['C:\\user\\bin', 'C:\\machine\\bin', 'C:\\Windows\\system32'])
  })
})

describe('withExtraPath', () => {
  it('adds what is missing at the end and keeps the person\'s own order', () => {
    expect(withExtraPath('C:\\a;C:\\b', ['C:\\c', 'C:\\a'], 'win32')).toBe('C:\\a;C:\\b;C:\\c')
  })
})

describe('toolDirectories', () => {
  it('lists where Windows installers put command line tools', () => {
    const dirs = toolDirectories({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')
    expect(dirs).toContain('C:\\Users\\me\\AppData\\Roaming\\npm')
    expect(dirs.some((dir) => /scoop[\\/]shims$/.test(dir))).toBe(true)
    expect(dirs.some((dir) => /\.bun[\\/]bin$/.test(dir))).toBe(true)
    expect(dirs).toContain('C:\\Users\\me\\AppData\\Local\\pnpm')
  })
})
