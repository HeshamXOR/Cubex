import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the seam between the renderer and the main process, where features have silently died before:
 * a channel in the contract with no handler throws "No handler registered" the first time the UI calls it,
 * and an API method the preload never bridges is `undefined` in the packaged app. Both read as working
 * code in the browser preview, because the preview stub answers every call.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string): string => readFileSync(join(repo, path), 'utf8')

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__fixtures__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const sharedIpc = read('src/shared/ipc.ts')
const preload = read('src/preload/index.ts')
const mainSource = sourceFiles('src/main').map((file) => read(file)).join('\n')

const channelKeys = [...(/export const IPC = \{([\s\S]*?)\} as const/.exec(sharedIpc)?.[1] ?? '').matchAll(/^\s*(\w+):\s*'[^']+'/gm)].map((m) => m[1]!)

const apiBlock = /export interface CubexAPI \{([\s\S]*?)\n\}/.exec(sharedIpc)?.[1] ?? ''
const apiMethods = [...apiBlock.matchAll(/^ {2}(\w+)[(<:]/gm)].map((m) => m[1]!)

/**
 * Channels in the contract that no main-process code handles yet. Delete a line when you wire its handler;
 * the test fails for a stale line too, so this list can only shrink, and it must be empty before release.
 */
const NOT_WIRED_YET: string[] = []

describe('IPC contract', () => {
  it('finds the contract it is checking', () => {
    expect(channelKeys.length).toBeGreaterThan(60)
    expect(apiMethods.length).toBeGreaterThan(60)
  })

  it('bridges every channel in the preload', () => {
    const missing = channelKeys.filter((key) => !new RegExp(`IPC\\.${key}\\b`).test(preload))
    expect(missing, 'channels the preload never uses, so the renderer cannot reach them').toEqual([])
  })

  it('bridges every CubexAPI method in the preload', () => {
    const missing = apiMethods.filter((method) => !new RegExp(`^\\s*${method}\\s*:`, 'm').test(preload))
    expect(missing, 'API methods that are undefined in the packaged app').toEqual([])
  })

  it('handles every channel in the main process', () => {
    const unhandled = channelKeys.filter((key) => !new RegExp(`IPC\\.${key}\\b`).test(mainSource))
    expect([...unhandled].sort(), 'Wire the handler, then remove the channel from NOT_WIRED_YET').toEqual([...NOT_WIRED_YET].sort())
  })

  it('handles no channel twice', () => {
    // ipcMain.handle throws on a second registration, which would stop the app from starting.
    const twice = channelKeys.filter((key) => (mainSource.match(new RegExp(`handle\\(\\s*IPC\\.${key}\\b`, 'g')) ?? []).length > 1)
    expect(twice).toEqual([])
  })
})
