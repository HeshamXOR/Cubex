import type { AppInfo } from '../../../../shared/ipc'
import type { PreviewSeed } from './index'

const sample: AppInfo = {
  version: '0.4.2',
  packaged: true,
  electron: '33.4.0',
  chrome: '130.0.6723.170',
  node: '20.18.1',
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\Cubex\\cubex-data',
  logsDir: 'C:\\Users\\dev\\AppData\\Roaming\\Cubex\\cubex-data\\logs'
}

/**
 * `?about=error` makes the version lookup fail, `?about=openfail` makes opening a folder fail,
 * and `?about=source` shows a checkout run from source.
 */
export const seed: PreviewSeed = {
  api: (flags) => {
    const mode = flags.get('about')
    return {
      appInfo: async () => {
        if (mode === 'error') throw new Error('The main process did not answer. Restart Cubex if this stays.')
        return mode === 'source' ? { ...sample, packaged: false, version: '0.4.3' } : sample
      },
      openAppFolder: async () => (mode === 'openfail' ? 'The system cannot find the path specified.' : '')
    }
  }
}
