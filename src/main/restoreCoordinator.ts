import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Conversation, PlanAsk, RestoreAxes, RestorePreview, RestoreResult, RestoreUndoResult, StoredMessage } from '@shared/ipc'
import type { CheckpointStore } from './checkpoints'

/** What a restore works on. ChatService owns these stores, so it hands them over (`ChatService.restoreHost`). */
export interface RestoreHost {
  checkpoints: Pick<CheckpointStore, 'preview' | 'restore' | 'undo'>
  /** Why history cannot be rewritten right now (a turn or a summary is running); undefined when it can. */
  lockedReason(conversationId: string): string | undefined
  /** Files a restore wrote back now hold Cubex's latest write, as far as review is concerned. */
  syncRestoredFiles(conversationId: string, paths: string[]): Promise<void>
  /** A write an undo made, so review tracks the file again. `before` is what the file held just before. */
  trackWrite(conversationId: string, path: string, before: Buffer, existed: boolean, after: Buffer | null): void
  /** Review keeps a baseline per turn; those of removed turns mean nothing. */
  forgetReviewTurns(conversationId: string, fromMessageId: string): void
  plans: { removeSince(conversationId: string, since: number): PlanAsk[]; restore(plans: PlanAsk[]): void }
}

export interface RestoreRepo {
  get(id: string): Conversation | null
  update(id: string, patch: Partial<Conversation>): void
}

type ContextCut = Pick<Conversation, 'contextStartMessageId' | 'contextSummary' | 'contextSummaryAt'>

interface UndoRecord {
  id: string
  /** The checkpoint store's own undo id, when files were restored. */
  filesUndoId?: string
  /** What the conversation looked like before it was cut back. */
  conversation?: {
    removed: StoredMessage[]
    /** The ids that remained; an undo is refused when the conversation no longer reads exactly like this. */
    keptIds: string[]
    context: ContextCut
    plans: PlanAsk[]
  }
}

/** Undo records are kept for the most recent restores only. */
const UNDO_RECORDS = 16
const MAX_ID_LENGTH = 256

export function parseMessageId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH) throw new Error('Invalid message id.')
  return value
}

export function parseUndoId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('Invalid undo id.')
  return value
}

export function parseRestoreAxes(value: unknown): RestoreAxes {
  const axes = value as { code?: unknown; conversation?: unknown } | null
  if (!axes || typeof axes.code !== 'boolean' || typeof axes.conversation !== 'boolean') throw new Error('Choose what to restore: the code, the conversation, or both.')
  if (!axes.code && !axes.conversation) throw new Error('Choose what to restore: the code, the conversation, or both.')
  return { code: axes.code, conversation: axes.conversation }
}

/** A path as the person knows it: relative to the workspace, or untouched when the file lies outside it. */
function display(workspace: string | undefined, path: string): string {
  if (!workspace) return path
  const rel = relative(resolve(workspace), path)
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel.split(sep).join('/') : path
}

/**
 * Going back to just before a user message: the files, the conversation, or both. Every step that can refuse
 * (a running turn, a file changed outside Cubex, an unwritable file) runs before anything is cut from the
 * conversation, and each restore can be undone until the next message is sent.
 */
export class RestoreCoordinator {
  private readonly undos = new Map<string, UndoRecord>()
  private readonly busy = new Set<string>()

  constructor(private readonly host: RestoreHost, private readonly repo: RestoreRepo) {}

  private locate(conversationId: string, messageId: string): { conversation: Conversation; index: number } {
    const conversation = this.repo.get(conversationId)
    if (!conversation) throw new Error('This task was not found.')
    const index = conversation.messages.findIndex((message) => message.id === messageId && message.role === 'user')
    if (index < 0) throw new Error('That message is no longer in this conversation.')
    return { conversation, index }
  }

  private async exclusive<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const locked = this.host.lockedReason(conversationId)
    if (locked) throw new Error(locked)
    if (this.busy.has(conversationId)) throw new Error('A restore is already running for this task.')
    this.busy.add(conversationId)
    try { return await work() } finally { this.busy.delete(conversationId) }
  }

  /** What going back to just before this message would change. */
  async preview(conversationId: string, messageId: string): Promise<RestorePreview> {
    const { conversation, index } = this.locate(conversationId, messageId)
    // Messages from the chosen one on, so a later turn counts even when this message's own turn left no file record.
    const userIds = conversation.messages.slice(index).filter((message) => message.role === 'user').map((message) => message.id)
    const preview = await this.host.checkpoints.preview(conversationId, userIds)
    return {
      checkpoint: preview.known,
      files: preview.restorable.map((file) => ({ path: display(conversation.workspacePath, file.path), action: file.action })),
      blocked: preview.blocked.map((file) => ({ path: display(conversation.workspacePath, file.path), reason: file.reason }))
    }
  }

  async restore(conversationId: string, messageId: string, axes: RestoreAxes): Promise<RestoreResult> {
    return this.exclusive(conversationId, async () => {
      const { conversation, index } = this.locate(conversationId, messageId)
      const workspace = conversation.workspacePath
      const result: RestoreResult = { restored: [], skipped: [], failed: [] }
      const record: UndoRecord = { id: randomUUID() }

      if (axes.code) {
        const userIds = conversation.messages.slice(index).filter((message) => message.role === 'user').map((message) => message.id)
        const files = await this.host.checkpoints.restore(conversationId, userIds)
        result.restored = files.restored.map((path) => display(workspace, path))
        result.skipped = files.skipped.map((file) => ({ path: display(workspace, file.path), reason: file.reason }))
        result.failed = files.failed.map((file) => ({ path: display(workspace, file.path), reason: file.reason }))
        if (files.restored.length) await this.host.syncRestoredFiles(conversationId, files.restored)
        if (files.undoId) record.filesUndoId = files.undoId
        // A file that could not be written keeps the conversation whole: the message to retry from must still be there.
        if (files.failed.length) return this.finish(conversationId, record, result)
      }

      if (axes.conversation) {
        try {
          const cut = this.cutConversation(conversation, index)
          record.conversation = cut.record
          result.conversation = cut.summary
        } catch (error) {
          if (record.filesUndoId) await this.host.checkpoints.undo(conversationId, record.filesUndoId).catch(() => undefined)
          throw error
        }
      }
      return this.finish(conversationId, record, result)
    })
  }

  /** Remove the message and everything after it, with the plans and summary of those turns. */
  private cutConversation(conversation: Conversation, index: number): { record: NonNullable<UndoRecord['conversation']>; summary: NonNullable<RestoreResult['conversation']> } {
    const kept = conversation.messages.slice(0, index)
    const removed = conversation.messages.slice(index)
    const boundary = conversation.contextStartMessageId
    const boundaryIndex = boundary ? conversation.messages.findIndex((message) => message.id === boundary) : -1
    // The summary stands in for the messages before the boundary. If the boundary goes, so do the turns it described.
    const contextCleared = !!boundary && (boundaryIndex < 0 || boundaryIndex >= index)
    const context: ContextCut = {
      contextStartMessageId: conversation.contextStartMessageId,
      contextSummary: conversation.contextSummary,
      contextSummaryAt: conversation.contextSummaryAt
    }
    const plans = this.host.plans.removeSince(conversation.id, removed[0]!.createdAt)
    try {
      this.repo.update(conversation.id, {
        messages: kept,
        ...(contextCleared ? { contextStartMessageId: undefined, contextSummary: undefined, contextSummaryAt: undefined } : {})
      })
    } catch (error) {
      try { this.host.plans.restore(plans) } catch { /* the original failure is the one to report */ }
      throw error
    }
    this.host.forgetReviewTurns(conversation.id, removed[0]!.id)
    return {
      record: { removed, keptIds: kept.map((message) => message.id), context, plans },
      summary: { removedMessages: removed.length, removedPlanIds: plans.map((plan) => plan.id), contextCleared }
    }
  }

  private finish(conversationId: string, record: UndoRecord, result: RestoreResult): RestoreResult {
    if (!record.filesUndoId && !record.conversation) return result
    this.undos.delete(conversationId)
    this.undos.set(conversationId, record)
    for (const id of [...this.undos.keys()].slice(0, Math.max(0, this.undos.size - UNDO_RECORDS))) this.undos.delete(id)
    return { ...result, undoId: record.id }
  }

  /** Undo the last restore of a task, as long as the conversation and the files are as the restore left them. */
  async undo(conversationId: string, undoId: string): Promise<RestoreUndoResult> {
    return this.exclusive(conversationId, async () => {
      const record = this.undos.get(conversationId)
      if (!record || record.id !== undoId) throw new Error('This restore can no longer be undone.')
      const conversation = this.repo.get(conversationId)
      if (!conversation) throw new Error('This task was not found.')
      const cut = record.conversation
      if (cut && (conversation.messages.length !== cut.keptIds.length || conversation.messages.some((message, i) => message.id !== cut.keptIds[i]))) {
        throw new Error('The conversation changed after the restore, so it cannot be undone.')
      }

      // Files go first: they are the step that can refuse, and a refusal must leave the conversation as it is.
      const restored: string[] = []
      if (record.filesUndoId) {
        const files = await this.host.checkpoints.undo(conversationId, record.filesUndoId)
        for (const write of files.writes) this.host.trackWrite(conversationId, write.path, write.before ?? Buffer.alloc(0), write.before !== null, write.after)
        restored.push(...files.restored.map((path) => display(conversation.workspacePath, path)))
      }
      if (cut) {
        this.repo.update(conversationId, { messages: [...conversation.messages, ...cut.removed], ...cut.context })
        this.host.plans.restore(cut.plans)
      }
      this.undos.delete(conversationId)
      return { restored, conversation: !!cut }
    })
  }
}
