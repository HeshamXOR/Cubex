import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { Conversation } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  conversation: undefined as Conversation | undefined,
  update: vi.fn()
}))
vi.mock('../db', () => ({ conversationRepo: { get: () => mocks.conversation ?? null, update: mocks.update } }))

import { register } from './restore'

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const restoreHost = vi.fn()

const ctx = {
  handle: (channel: string, fn: Handler) => { handlers.set(channel, fn) },
  taskIdArg: (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid task id.')
    return value
  },
  chat: { restoreHost }
}

const call = async (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!(...args)

beforeEach(() => {
  handlers.clear()
  mocks.update.mockClear()
  restoreHost.mockReset()
  mocks.conversation = {
    id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud',
    messages: [{ id: 'u1', role: 'user', text: 'one', createdAt: 10 }, { id: 'a1', role: 'assistant', text: 'reply', createdAt: 20 }]
  }
  restoreHost.mockReturnValue({
    checkpoints: { preview: vi.fn(async () => ({ known: false, restorable: [], blocked: [] })), restore: vi.fn(), undo: vi.fn() },
    lockedReason: () => undefined,
    syncRestoredFiles: vi.fn(),
    trackWrite: vi.fn(),
    forgetReviewTurns: vi.fn(),
    plans: { removeSince: () => [], restore: vi.fn() }
  })
  register(ctx as never)
})

describe('restore handlers', () => {
  it('declares the three channels without touching the chat service', () => {
    expect([...handlers.keys()].sort()).toEqual([IPC.restoreCheckpoint, IPC.restorePreview, IPC.restoreUndo].sort())
    expect(restoreHost).not.toHaveBeenCalled()
  })

  it('rejects arguments that are not what the contract says', async () => {
    await expect(call(IPC.restoreCheckpoint, 42, 'u1', { code: true, conversation: true })).rejects.toThrow('Invalid task id')
    await expect(call(IPC.restoreCheckpoint, 'task', '', { code: true, conversation: true })).rejects.toThrow('Invalid message id')
    await expect(call(IPC.restoreCheckpoint, 'task', 'u1', { code: false, conversation: false })).rejects.toThrow('Choose what to restore')
    await expect(call(IPC.restoreCheckpoint, 'task', 'u1', 'both')).rejects.toThrow('Choose what to restore')
    await expect(call(IPC.restorePreview, 'task', 'x'.repeat(300))).rejects.toThrow('Invalid message id')
    await expect(call(IPC.restoreUndo, 'task', 7)).rejects.toThrow('Invalid undo id')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('answers a preview and cuts the conversation on a restore', async () => {
    expect(await call(IPC.restorePreview, 'task', 'u1')).toEqual({ checkpoint: false, files: [], blocked: [] })
    const result = await call(IPC.restoreCheckpoint, 'task', 'u1', { code: false, conversation: true })
    expect(result).toMatchObject({ conversation: { removedMessages: 2 } })
    expect(mocks.update).toHaveBeenCalledWith('task', expect.objectContaining({ messages: [] }))
    // One coordinator serves every call, so an undo id from a restore is still known to the next handler.
    expect(restoreHost).toHaveBeenCalledTimes(1)
  })
})
