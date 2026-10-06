import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { register } from './review'

const HUNK = 'a'.repeat(40)
const OTHER_HUNK = 'b'.repeat(40)
const FILE_HASH = 'c'.repeat(64)
const REVERT_ID = '0b8f1d52-6a4e-4c0c-9a54-4f2d2b6f6f10'

/** Register the module against a fake context and call its handlers the way ipcMain would. */
function setup(): { call: (channel: string, ...args: unknown[]) => Promise<unknown>; chat: Record<string, ReturnType<typeof vi.fn>>; channels: string[] } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const chat = {
    getReview: vi.fn(async () => []),
    revertHunks: vi.fn(async () => ({ applied: [], conflicts: [], newHeadHash: null })),
    markReviewed: vi.fn(async () => undefined),
    undoRevert: vi.fn(async () => ({ restored: [] })),
    sendReviewComments: vi.fn(async () => ({ messageId: 'm', streamId: 's', text: 't' }))
  }
  register({
    handle: (channel: string, fn: (...args: never[]) => unknown) => { handlers.set(channel, fn as (...args: unknown[]) => unknown) },
    chat,
    taskIdArg: (value: unknown) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid task id.')
      return value
    }
  } as never)
  // A handler that throws before it returns still rejects, as it does under ipcMain.handle.
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!(...args)
  return { call, chat, channels: [...handlers.keys()] }
}

const comment = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1', path: 'src/a.ts', startLine: 4, endLine: 6, side: 'new', hunkId: HUNK, text: 'Why?', ...extra
})

describe('review IPC module', () => {
  it('handles the five review channels and nothing else', () => {
    expect(setup().channels.sort()).toEqual([IPC.reviewComments, IPC.reviewGet, IPC.reviewMark, IPC.reviewRevertHunks, IPC.reviewUndo].sort())
  })

  describe('reviewGet', () => {
    it('passes a known scope through and rejects a malformed one before the service runs', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewGet, 't1', { kind: 'session', extra: 1 })
      await call(IPC.reviewGet, 't1', { kind: 'turn', messageId: 'm1' })
      await call(IPC.reviewGet, 't1', { kind: 'uncommitted' })
      await call(IPC.reviewGet, 't1', { kind: 'branch', base: 'main' })
      expect(chat.getReview!.mock.calls).toEqual([
        ['t1', { kind: 'session' }], ['t1', { kind: 'turn', messageId: 'm1' }], ['t1', { kind: 'uncommitted' }], ['t1', { kind: 'branch', base: 'main' }]
      ])
      for (const bad of [undefined, null, 'session', [], {}, { kind: 'bogus' }, { kind: 'turn' }, { kind: 'turn', messageId: '' }, { kind: 'turn', messageId: 'x'.repeat(257) }, { kind: 'branch', base: '-delete' }, { kind: 'branch', base: 7 }]) {
        await expect(call(IPC.reviewGet, 't1', bad)).rejects.toThrow(/scope|message id|branch/)
      }
      await expect(call(IPC.reviewGet, '', { kind: 'session' })).rejects.toThrow('Invalid task id.')
      expect(chat.getReview).toHaveBeenCalledTimes(4)
    })
  })

  describe('reviewRevertHunks', () => {
    it('passes a clean request, dropping repeated hunk ids and unknown fields', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewRevertHunks, 't1', { path: 'src/a.ts', hunkIds: [HUNK, HUNK, OTHER_HUNK], expectHeadHash: FILE_HASH, sneaky: true })
      await call(IPC.reviewRevertHunks, 't1', { path: 'gone.ts', hunkIds: [HUNK], expectHeadHash: '' })
      expect(chat.revertHunks!.mock.calls).toEqual([
        ['t1', { path: 'src/a.ts', hunkIds: [HUNK, OTHER_HUNK], expectHeadHash: FILE_HASH }],
        ['t1', { path: 'gone.ts', hunkIds: [HUNK], expectHeadHash: '' }]
      ])
    })

    it('rejects paths that leave the workspace, bad hunk ids and bad hashes', async () => {
      const { call, chat } = setup()
      const ok = { path: 'a.ts', hunkIds: [HUNK], expectHeadHash: FILE_HASH }
      for (const path of ['', '   ', 7, null, '/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', 'bad\0path', 'x'.repeat(4097)]) {
        await expect(call(IPC.reviewRevertHunks, 't1', { ...ok, path })).rejects.toThrow('relative to the workspace')
      }
      for (const ids of [[], 'a', [7], ['nothex'], ['A'.repeat(40)], [HUNK.slice(1)], Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(40, '0'))]) {
        await expect(call(IPC.reviewRevertHunks, 't1', { ...ok, hunkIds: ids })).rejects.toThrow('Hunk ids')
      }
      for (const hash of [undefined, null, 'abc', 'C'.repeat(64), 'c'.repeat(63), 5]) {
        await expect(call(IPC.reviewRevertHunks, 't1', { ...ok, expectHeadHash: hash })).rejects.toThrow('64-character')
      }
      for (const request of [undefined, null, 'x', []]) await expect(call(IPC.reviewRevertHunks, 't1', request)).rejects.toThrow('revert request')
      expect(chat.revertHunks).not.toHaveBeenCalled()
    })
  })

  describe('reviewMark', () => {
    it('passes each reviewed file with the hash it was reviewed at', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewMark, 't1', [{ path: 'a.ts', hunkIds: [HUNK], headHash: FILE_HASH, note: 'x' }])
      await call(IPC.reviewMark, 't1', [])
      expect(chat.markReviewed!.mock.calls).toEqual([['t1', [{ path: 'a.ts', hunkIds: [HUNK], headHash: FILE_HASH }]], ['t1', []]])
    })

    it('rejects a missing hash, a path outside the workspace and a list that is too long', async () => {
      const { call, chat } = setup()
      await expect(call(IPC.reviewMark, 't1', [{ path: 'a.ts', hunkIds: [HUNK] }])).rejects.toThrow('hash')
      await expect(call(IPC.reviewMark, 't1', [{ path: '/a.ts', hunkIds: [HUNK], headHash: FILE_HASH }])).rejects.toThrow('relative')
      await expect(call(IPC.reviewMark, 't1', [{ path: 'a.ts', hunkIds: [], headHash: FILE_HASH }])).rejects.toThrow('Hunk ids')
      await expect(call(IPC.reviewMark, 't1', 'a.ts')).rejects.toThrow('list')
      await expect(call(IPC.reviewMark, 't1', Array.from({ length: 201 }, () => ({ path: 'a.ts', hunkIds: [HUNK], headHash: FILE_HASH })))).rejects.toThrow('at most 200')
      expect(chat.markReviewed).not.toHaveBeenCalled()
    })
  })

  describe('reviewUndo', () => {
    it('accepts a revert id and nothing that could name another file', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewUndo, 't1', REVERT_ID)
      expect(chat.undoRevert).toHaveBeenCalledWith('t1', REVERT_ID)
      for (const bad of [undefined, '', '../../etc/passwd', REVERT_ID.toUpperCase(), `${REVERT_ID}0`, 12, {}]) {
        await expect(call(IPC.reviewUndo, 't1', bad)).rejects.toThrow('Invalid revert id.')
      }
      expect(chat.undoRevert).toHaveBeenCalledTimes(1)
    })
  })

  describe('reviewComments', () => {
    it('passes trimmed comments and the options that matter, with only the model taken from the policy', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewComments, 't1', [comment({ text: '  Why?\n', extra: 1 }), comment({ id: 'c2', hunkId: undefined, side: 'old', startLine: 9, endLine: 9 })], {
        streamId: 'stream_1',
        request: {
          policy: { primary: { providerId: 'p', model: 'm', params: { maxOutputTokens: 4096, reasoningEffort: 'high', temperature: 2 } }, fallbacks: [{ providerId: 'x', model: 'y' }], fallbackEnabled: true, retry: { enabled: false } },
          permissionMode: 'acceptEdits', longContext: true, systemPrompt: 'Be brief.', userText: 'ignored', conversationId: 'other'
        }
      })
      expect(chat.sendReviewComments!.mock.calls).toEqual([[
        't1',
        [
          { id: 'c1', path: 'src/a.ts', startLine: 4, endLine: 6, side: 'new', hunkId: HUNK, text: 'Why?' },
          { id: 'c2', path: 'src/a.ts', startLine: 9, endLine: 9, side: 'old', text: 'Why?' }
        ],
        {
          streamId: 'stream_1',
          overrides: { target: { providerId: 'p', model: 'm', params: { maxOutputTokens: 4096, reasoningEffort: 'high' } }, permissionMode: 'acceptEdits', longContext: true, systemPrompt: 'Be brief.' }
        }
      ]])
    })

    it('works without options', async () => {
      const { call, chat } = setup()
      await call(IPC.reviewComments, 't1', [comment()])
      await call(IPC.reviewComments, 't1', [comment()], null)
      expect(chat.sendReviewComments!.mock.calls.map((args) => args[2])).toEqual([{}, {}])
    })

    it('rejects an empty, oversize or malformed batch before anything is sent', async () => {
      const { call, chat } = setup()
      await expect(call(IPC.reviewComments, 't1', [])).rejects.toThrow('between 1 and 50')
      await expect(call(IPC.reviewComments, 't1', 'text')).rejects.toThrow('between 1 and 50')
      await expect(call(IPC.reviewComments, 't1', Array.from({ length: 51 }, () => comment()))).rejects.toThrow('between 1 and 50')
      const bad: Array<[Record<string, unknown>, RegExp]> = [
        [{ text: '' }, /characters of text/], [{ text: '   ' }, /characters of text/], [{ text: 'x'.repeat(4001) }, /characters of text/], [{ text: 5 }, /characters of text/],
        [{ side: 'both' }, /side/], [{ side: undefined }, /side/],
        [{ startLine: 0 }, /line number/], [{ startLine: 1.5 }, /line number/], [{ endLine: '3' }, /line number/], [{ endLine: 10_000_001 }, /line number/],
        [{ startLine: 8, endLine: 7 }, /before it starts/],
        [{ hunkId: 'xyz' }, /hunk/], [{ hunkId: 7 }, /hunk/],
        [{ path: '/abs/a.ts' }, /relative/], [{ path: 'D:\\a.ts' }, /relative/],
        [{ id: '' }, /comment id/], [{ id: 'x'.repeat(129) }, /comment id/]
      ]
      for (const [fields, message] of bad) await expect(call(IPC.reviewComments, 't1', [comment(fields)])).rejects.toThrow(message)
      await expect(call(IPC.reviewComments, 't1', [null])).rejects.toThrow('A comment is invalid.')
      expect(chat.sendReviewComments).not.toHaveBeenCalled()
    })

    it('rejects malformed options', async () => {
      const { call, chat } = setup()
      const send = (options: unknown): Promise<unknown> => call(IPC.reviewComments, 't1', [comment()], options)
      await expect(send('x')).rejects.toThrow('send options')
      await expect(send({ streamId: 'has space' })).rejects.toThrow('stream id')
      await expect(send({ streamId: 7 })).rejects.toThrow('stream id')
      await expect(send({ request: 'x' })).rejects.toThrow('request settings')
      await expect(send({ request: { permissionMode: 'root' } })).rejects.toThrow('permission mode')
      await expect(send({ request: { longContext: 'yes' } })).rejects.toThrow('long-context')
      await expect(send({ request: { systemPrompt: 'x'.repeat(200_001) } })).rejects.toThrow('system prompt')
      await expect(send({ request: { policy: {} } })).rejects.toThrow('model for this request')
      await expect(send({ request: { policy: { primary: { providerId: '', model: 'm' } } } })).rejects.toThrow('provider')
      await expect(send({ request: { policy: { primary: { providerId: 'p', model: 'x'.repeat(301) } } } })).rejects.toThrow('model')
      await expect(send({ request: { policy: { primary: { providerId: 'p', model: 'm', params: { maxOutputTokens: 0 } } } } })).rejects.toThrow('output limit')
      await expect(send({ request: { policy: { primary: { providerId: 'p', model: 'm', params: { reasoningEffort: 'extreme' } } } } })).rejects.toThrow('reasoning effort')
      expect(chat.sendReviewComments).not.toHaveBeenCalled()
    })

    it('validates the task id first', async () => {
      const { call, chat } = setup()
      await expect(call(IPC.reviewComments, 7, [comment()])).rejects.toThrow('Invalid task id.')
      expect(chat.sendReviewComments).not.toHaveBeenCalled()
    })
  })
})
