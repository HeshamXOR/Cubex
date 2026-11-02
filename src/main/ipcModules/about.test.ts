import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type AppInfo } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  version: '1.2.3',
  packaged: true,
  openPath: vi.fn(async (_path: string) => '')
}))
vi.mock('electron', () => ({
  app: { getVersion: () => mocks.version, get isPackaged() { return mocks.packaged } },
  shell: { openPath: (path: string) => mocks.openPath(path) }
}))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), release: () => '10.0.22631' }))
vi.mock('../paths', () => ({ dataDir: () => 'C:\\data', logsDir: () => 'C:\\data\\logs' }))

import { parseFolderKind, register } from './about'

let handlers: Map<string, (...args: unknown[]) => unknown>

beforeEach(() => {
  handlers = new Map()
  mocks.version = '1.2.3'
  mocks.packaged = true
  mocks.openPath.mockReset().mockResolvedValue('')
  register({
    handle: (channel: string, fn: (...args: never[]) => unknown) => { handlers.set(channel, fn as (...args: unknown[]) => unknown) }
  } as never)
})

describe('about handlers', () => {

  it('reports the version, runtime and folders of the running app', () => {
    const info = handlers.get(IPC.appInfo)!() as AppInfo
    expect(info).toMatchObject({ version: '1.2.3', packaged: true, osRelease: '10.0.22631', dataDir: 'C:\\data', logsDir: 'C:\\data\\logs' })
    expect(info.node).toBe(process.versions.node)
    expect(info.platform).toBe(process.platform)
    expect(info.arch).toBe(process.arch)
  })

  it('opens the folder it names, never a path the window sends', async () => {
    const open = handlers.get(IPC.openAppFolder)!
    await expect(open('logs')).resolves.toBe('')
    expect(mocks.openPath).toHaveBeenLastCalledWith('C:\\data\\logs')
    await open('data')
    expect(mocks.openPath).toHaveBeenLastCalledWith('C:\\data')
  })

  it.each([['C:\\Windows'], ['../logs'], [undefined], [null], [7], [{ kind: 'data' }], ['DATA']])('refuses %j as a folder', (value) => {
    expect(() => handlers.get(IPC.openAppFolder)!(value)).toThrow('Unknown folder.')
    expect(() => parseFolderKind(value)).toThrow('Unknown folder.')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })
})
