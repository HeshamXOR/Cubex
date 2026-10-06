import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import { registerIpcModules } from './index'

describe('IPC module registry', () => {
  it('registers each module against known channels, once each', () => {
    const seen: string[] = []
    // Registration must only declare handlers; nothing here may touch a service until a handler runs.
    const ctx = {
      handle: (channel: string) => { seen.push(channel) },
      send: () => undefined,
      onChatEvent: () => () => undefined,
      getWindow: () => null,
      chat: {},
      local: {},
      providers: {},
      taskIdArg: (value: unknown) => String(value),
      taskWorkspace: () => undefined
    }
    const cleanups = registerIpcModules(ctx as never)

    const known = new Set<string>(Object.values(IPC))
    expect(seen.filter((channel) => !known.has(channel)), 'channels that are not in the IPC contract').toEqual([])
    expect(seen.filter((channel, index) => seen.indexOf(channel) !== index), 'channels two modules both handle').toEqual([])
    for (const cleanup of cleanups) cleanup()
  })
})
