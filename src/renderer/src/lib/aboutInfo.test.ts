import { describe, expect, it } from 'vitest'
import type { AppInfo } from '../../../shared/ipc'
import { aboutDetails, buildKind, platformName, runtimeLine, systemLine } from './aboutInfo'

const info: AppInfo = {
  version: '0.4.2',
  packaged: true,
  electron: '33.4.0',
  chrome: '130.0.6723.170',
  node: '20.18.1',
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  dataDir: 'C:\\data',
  logsDir: 'C:\\data\\logs'
}

describe('aboutInfo', () => {
  it('names the platforms people know and passes unknown ones through', () => {
    expect(platformName('win32')).toBe('Windows')
    expect(platformName('darwin')).toBe('macOS')
    expect(platformName('linux')).toBe('Linux')
    expect(platformName('freebsd')).toBe('freebsd')
  })

  it('says whether this is an installed build', () => {
    expect(buildKind(info)).toBe('Installed build')
    expect(buildKind({ ...info, packaged: false })).toBe('Running from source')
  })

  it('lists the runtime versions, leaving out the ones not reported', () => {
    expect(runtimeLine(info)).toBe('Electron 33.4.0, Chrome 130.0.6723.170, Node 20.18.1')
    expect(runtimeLine({ ...info, electron: '', chrome: '' })).toBe('Node 20.18.1')
  })

  it('describes the system without dangling separators', () => {
    expect(systemLine(info)).toBe('Windows x64, 10.0.22631')
    expect(systemLine({ ...info, osRelease: '' })).toBe('Windows x64')
    expect(systemLine({ ...info, platform: 'browser', arch: '', osRelease: '' })).toBe('browser')
  })

  it('writes the details a bug report needs, one fact per line', () => {
    expect(aboutDetails(info)).toBe([
      'Cubex 0.4.2 (installed build)',
      'Electron 33.4.0, Chrome 130.0.6723.170, Node 20.18.1',
      'Windows x64, 10.0.22631',
      'Data folder: C:\\data',
      'Logs folder: C:\\data\\logs'
    ].join('\n'))
  })
})
