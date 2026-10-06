import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import type { Conversation, PlanAsk, StoredMessage } from '@shared/ipc'
import { RestoreCoordinator, parseMessageId, parseRestoreAxes, parseUndoId, type RestoreHost } from './restoreCoordinator'

const WORKSPACE = resolve('restore-workspace')
const abs = (path: string): string => join(WORKSPACE, path)

const message = (id: string, role: StoredMessage['role'], createdAt: number): StoredMessage => ({ id, role, text: id, createdAt })

/** Three exchanges: u1 a1 u2 a2 u3 a3, one second apart. */
function conversation(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: WORKSPACE,
    messages: [message('u1', 'user', 1000), message('a1', 'assistant', 1500), message('u2', 'user', 2000),
      message('a2', 'assistant', 2500), message('u3', 'user', 3000), message('a3', 'assistant', 3500)],
    ...extra
  }
}

const plan = (id: string, createdAt: number): PlanAsk => ({ id, plan: `# ${id}`, title: id, conversationId: 'task', createdAt, status: 'approved' })

function setup(initial: Conversation = conversation()) {
  const stored = new Map<string, Conversation>([[initial.id, structuredClone(initial)]])
  const repo = {
    get: vi.fn((id: string) => structuredClone(stored.get(id) ?? null)),
    update: vi.fn((id: string, patch: Partial<Conversation>) => { stored.set(id, { ...stored.get(id)!, ...patch }) })
  }
  const removedPlans = [plan('plan-late', 3200)]
  const host = {
    checkpoints: {
      preview: vi.fn(async () => ({ known: true, restorable: [{ path: abs('src/a.ts'), action: 'revert' as const }], blocked: [{ path: abs('src/b.ts'), reason: 'Changed outside Cubex since its last edit' }] })),
      restore: vi.fn(async () => ({ known: true, restored: [abs('src/a.ts')], skipped: [{ path: abs('src/b.ts'), reason: 'Changed outside Cubex since its last edit' }], failed: [], undoId: 'files-undo' })),
      undo: vi.fn(async () => ({ restored: [abs('src/a.ts')], writes: [{ path: abs('src/a.ts'), before: Buffer.from('old'), after: Buffer.from('new') }] }))
    },
    lockedReason: vi.fn((): string | undefined => undefined),
    syncRestoredFiles: vi.fn(async () => undefined),
    trackWrite: vi.fn(),
    forgetReviewTurns: vi.fn(),
    plans: { removeSince: vi.fn(() => removedPlans), restore: vi.fn() }
  }
  return { coordinator: new RestoreCoordinator(host as unknown as RestoreHost, repo), host, repo, stored, removedPlans }
}

describe('previewing a restore', () => {
  it('counts the files from the chosen message on, as workspace-relative paths', async () => {
    const { coordinator, host } = setup()
    const preview = await coordinator.preview('task', 'u2')
    expect(preview).toEqual({
      checkpoint: true,
      files: [{ path: 'src/a.ts', action: 'revert' }],
      blocked: [{ path: 'src/b.ts', reason: 'Changed outside Cubex since its last edit' }]
    })
    // Only user messages begin turns, and only those from the chosen one on.
    expect(host.checkpoints.preview).toHaveBeenCalledWith('task', ['u2', 'u3'])
  })

  it('rejects a message that is not in the conversation, an assistant message, and an unknown task', async () => {
    const { coordinator } = setup()
    await expect(coordinator.preview('task', 'nope')).rejects.toThrow('no longer in this conversation')
    await expect(coordinator.preview('task', 'a1')).rejects.toThrow('no longer in this conversation')
    await expect(coordinator.preview('other', 'u1')).rejects.toThrow('not found')
  })
})

describe('restoring the conversation', () => {
  it('cuts the message and everything after it and saves what is left', async () => {
    const { coordinator, repo, host, stored } = setup()
    const result = await coordinator.restore('task', 'u2', { code: false, conversation: true })
    expect(stored.get('task')!.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(repo.update).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ restored: [], skipped: [], failed: [], conversation: { removedMessages: 4, removedPlanIds: ['plan-late'], contextCleared: false } })
    expect(result.undoId).toBeTruthy()
    expect(host.checkpoints.restore).not.toHaveBeenCalled()
    // Plans made at or after the chosen message went with its turns, and review forgets those turns.
    expect(host.plans.removeSince).toHaveBeenCalledWith('task', 2000)
    expect(host.forgetReviewTurns).toHaveBeenCalledWith('task', 'u2')
  })

  it('can empty the conversation by going back to its first message', async () => {
    const { coordinator, stored } = setup()
    const result = await coordinator.restore('task', 'u1', { code: false, conversation: true })
    expect(stored.get('task')!.messages).toEqual([])
    expect(result.conversation?.removedMessages).toBe(6)
  })

  it('drops the summary when the turns it summarized are removed, and keeps it when they are not', async () => {
    const summarized = conversation({ contextStartMessageId: 'u2', contextSummary: 'Goal: retries.', contextSummaryAt: 2600 })
    const gone = setup(summarized)
    expect((await gone.coordinator.restore('task', 'u2', { code: false, conversation: true })).conversation?.contextCleared).toBe(true)
    expect(gone.stored.get('task')).toMatchObject({ contextStartMessageId: undefined, contextSummary: undefined, contextSummaryAt: undefined })

    const kept = setup(summarized)
    expect((await kept.coordinator.restore('task', 'u3', { code: false, conversation: true })).conversation?.contextCleared).toBe(false)
    expect(kept.stored.get('task')).toMatchObject({ contextStartMessageId: 'u2', contextSummary: 'Goal: retries.' })
  })

  it('treats a boundary that points at no message as stale and clears it', async () => {
    const { coordinator, stored } = setup(conversation({ contextStartMessageId: 'long-gone', contextSummary: 'Old.', contextSummaryAt: 5 }))
    expect((await coordinator.restore('task', 'u3', { code: false, conversation: true })).conversation?.contextCleared).toBe(true)
    expect(stored.get('task')?.contextSummary).toBeUndefined()
  })
})

describe('restoring the code', () => {
  it('puts files back and leaves the conversation alone', async () => {
    const { coordinator, repo, host } = setup()
    const result = await coordinator.restore('task', 'u2', { code: true, conversation: false })
    expect(result.restored).toEqual(['src/a.ts'])
    expect(result.skipped).toEqual([{ path: 'src/b.ts', reason: 'Changed outside Cubex since its last edit' }])
    expect(result.conversation).toBeUndefined()
    expect(result.undoId).toBeTruthy()
    expect(repo.update).not.toHaveBeenCalled()
    expect(host.syncRestoredFiles).toHaveBeenCalledWith('task', [abs('src/a.ts')])
    expect(host.forgetReviewTurns).not.toHaveBeenCalled()
    expect(host.plans.removeSince).not.toHaveBeenCalled()
  })

  it('offers no undo when nothing was put back', async () => {
    const { coordinator, host } = setup()
    host.checkpoints.restore.mockResolvedValueOnce({ known: true, restored: [], skipped: [], failed: [], undoId: undefined } as never)
    const result = await coordinator.restore('task', 'u2', { code: true, conversation: false })
    expect(result.undoId).toBeUndefined()
  })

  it('keeps the conversation whole when a file could not be written, so the restore can be retried', async () => {
    const { coordinator, host, repo, stored } = setup()
    host.checkpoints.restore.mockResolvedValueOnce({
      known: true, restored: [abs('src/a.ts')], skipped: [], failed: [{ path: abs('src/c.ts'), reason: 'Another program is using it' }], undoId: 'files-undo'
    } as never)
    const result = await coordinator.restore('task', 'u2', { code: true, conversation: true })
    expect(result.failed).toEqual([{ path: 'src/c.ts', reason: 'Another program is using it' }])
    expect(result.conversation).toBeUndefined()
    expect(repo.update).not.toHaveBeenCalled()
    expect(stored.get('task')!.messages).toHaveLength(6)
    // What did get written can still be undone.
    expect(result.undoId).toBeTruthy()
  })

  it('does both in one go: files first, then the conversation', async () => {
    const { coordinator, host, repo } = setup()
    const order: string[] = []
    host.checkpoints.restore.mockImplementationOnce(async () => { order.push('files'); return { known: true, restored: [abs('src/a.ts')], skipped: [], failed: [], undoId: 'files-undo' } as never })
    repo.update.mockImplementationOnce(() => { order.push('conversation') })
    await coordinator.restore('task', 'u2', { code: true, conversation: true })
    expect(order).toEqual(['files', 'conversation'])
  })

  it('puts the files back again when the conversation cannot be saved', async () => {
    const { coordinator, host, repo } = setup()
    repo.update.mockImplementationOnce(() => { throw new Error('database is locked') })
    await expect(coordinator.restore('task', 'u2', { code: true, conversation: true })).rejects.toThrow('database is locked')
    expect(host.checkpoints.undo).toHaveBeenCalledWith('task', 'files-undo')
    expect(host.plans.restore).toHaveBeenCalled()
  })
})

describe('when a restore must not run', () => {
  it('refuses while a turn is running and touches nothing', async () => {
    const { coordinator, host, repo } = setup()
    host.lockedReason.mockReturnValue('Stop the running turn before restoring an earlier point.')
    await expect(coordinator.restore('task', 'u2', { code: true, conversation: true })).rejects.toThrow('Stop the running turn')
    await expect(coordinator.undo('task', 'whatever')).rejects.toThrow('Stop the running turn')
    expect(host.checkpoints.restore).not.toHaveBeenCalled()
    expect(repo.update).not.toHaveBeenCalled()
  })

  it('refuses a second restore of the same task while one is running', async () => {
    const { coordinator, host } = setup()
    let release!: () => void
    host.checkpoints.restore.mockImplementationOnce(() => new Promise((resolveRestore) => {
      release = () => resolveRestore({ known: true, restored: [], skipped: [], failed: [] } as never)
    }))
    const first = coordinator.restore('task', 'u2', { code: true, conversation: false })
    await expect(coordinator.restore('task', 'u2', { code: true, conversation: false })).rejects.toThrow('already running')
    release()
    await first
  })
})

describe('undoing a restore', () => {
  it('puts the files, the messages, the plans and the summary back', async () => {
    const summarized = conversation({ contextStartMessageId: 'u2', contextSummary: 'Goal: retries.', contextSummaryAt: 2600 })
    const { coordinator, stored, host, removedPlans } = setup(summarized)
    const original = structuredClone(stored.get('task')!)
    const { undoId } = await coordinator.restore('task', 'u2', { code: true, conversation: true })
    expect(stored.get('task')!.messages).toHaveLength(2)

    const undone = await coordinator.undo('task', undoId!)
    expect(undone).toEqual({ restored: ['src/a.ts'], conversation: true })
    expect(stored.get('task')).toMatchObject({ messages: original.messages, contextStartMessageId: 'u2', contextSummary: 'Goal: retries.', contextSummaryAt: 2600 })
    expect(host.plans.restore).toHaveBeenCalledWith(removedPlans)
    // Review tracks the file again as a write of what the undo put there.
    expect(host.trackWrite).toHaveBeenCalledWith('task', abs('src/a.ts'), Buffer.from('old'), true, Buffer.from('new'))
    await expect(coordinator.undo('task', undoId!)).rejects.toThrow('no longer be undone')
  })

  it('treats a file the restore removed or recreated as absent before the write', async () => {
    const { coordinator, host } = setup()
    host.checkpoints.undo.mockResolvedValueOnce({ restored: [abs('src/new.ts')], writes: [{ path: abs('src/new.ts'), before: null, after: Buffer.from('made') }] } as never)
    const { undoId } = await coordinator.restore('task', 'u2', { code: true, conversation: false })
    await coordinator.undo('task', undoId!)
    expect(host.trackWrite).toHaveBeenCalledWith('task', abs('src/new.ts'), Buffer.alloc(0), false, Buffer.from('made'))
  })

  it('is refused once the conversation reads differently, and then touches nothing', async () => {
    const { coordinator, stored, host } = setup()
    const { undoId } = await coordinator.restore('task', 'u2', { code: true, conversation: true })
    stored.set('task', { ...stored.get('task')!, messages: [...stored.get('task')!.messages, message('u4', 'user', 4000)] })
    await expect(coordinator.undo('task', undoId!)).rejects.toThrow('conversation changed')
    expect(host.checkpoints.undo).not.toHaveBeenCalled()
    expect(stored.get('task')!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u4'])
  })

  it('leaves the conversation cut when the files refuse to go back', async () => {
    const { coordinator, stored, host } = setup()
    const { undoId } = await coordinator.restore('task', 'u2', { code: true, conversation: true })
    host.checkpoints.undo.mockRejectedValueOnce(new Error('Undo stopped: these files changed after the restore.'))
    await expect(coordinator.undo('task', undoId!)).rejects.toThrow('Undo stopped')
    expect(stored.get('task')!.messages).toHaveLength(2)
  })

  it('only honors the id of the latest restore, and forgets old restores', async () => {
    const { coordinator } = setup()
    const first = await coordinator.restore('task', 'u3', { code: true, conversation: false })
    const second = await coordinator.restore('task', 'u2', { code: true, conversation: false })
    await expect(coordinator.undo('task', first.undoId!)).rejects.toThrow('no longer be undone')
    await expect(coordinator.undo('task', second.undoId!)).resolves.toMatchObject({ conversation: false })
  })
})

describe('arguments from the renderer', () => {
  it('accepts bounded ids and rejects anything else', () => {
    expect(parseMessageId('m-1')).toBe('m-1')
    for (const bad of [undefined, null, 42, '', '   ', 'x'.repeat(257), {}]) expect(() => parseMessageId(bad)).toThrow('Invalid message id')
    expect(parseUndoId('abc')).toBe('abc')
    for (const bad of [undefined, '', 'x'.repeat(129), 7]) expect(() => parseUndoId(bad)).toThrow('Invalid undo id')
  })

  it('needs two booleans and at least one of them true', () => {
    expect(parseRestoreAxes({ code: true, conversation: false })).toEqual({ code: true, conversation: false })
    expect(parseRestoreAxes({ code: true, conversation: true, extra: 'ignored' })).toEqual({ code: true, conversation: true })
    for (const bad of [undefined, null, 'both', {}, { code: true }, { code: 'yes', conversation: true }, { code: false, conversation: false }]) {
      expect(() => parseRestoreAxes(bad)).toThrow('Choose what to restore')
    }
  })
})
