import { IPC, type Conversation, type ConversationWorktree, type RaceRun, type WorktreeCommandResult } from '@shared/ipc'
import { getSettings } from '../config'
import { conversationRepo, usageRepo } from '../db'
import { detectCheckCommands } from '../projectCommands'
import { resolveShell } from '../shell/shellProvider'
import { applyWorktree, createWorktree, planWorktree, removeWorktree, summarizeWorktree, withBaseline, worktreeDiff } from '../worktrees'
import type { IpcContext } from './context'

const MAX_COMMANDS = 8
/** Installing dependencies can take a while. */
const COMMAND_TIMEOUT_MS = 20 * 60_000
const OUTPUT_TAIL = 2_000

function stringArg(value: unknown, what: string, limit = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${what}.`)
  return value
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim() && entry.length <= 2_000).slice(0, limit)
}

/** Tasks that are running keep a worktree's files open, and their edits would be lost. */
function assertIdle(ctx: IpcContext, conversationId: string): void {
  if (ctx.chat.hasRunningTurn(conversationId)) throw new Error('This task is still running. Stop it first.')
}

/** Worktrees, and comparing the tasks that raced each other. Each handler reads the worktree from storage, never from the renderer. */
export function register(ctx: IpcContext): void {
  const worktreeOf = (id: unknown): { conversation: Conversation; worktree: ConversationWorktree } => {
    const conversation = conversationRepo.get(ctx.taskIdArg(id))
    if (!conversation) throw new Error('Task was not found.')
    if (!conversation.worktree || conversation.worktree.removedAt) throw new Error('This task has no worktree.')
    return { conversation, worktree: conversation.worktree }
  }

  ctx.handle(IPC.worktreePlan, (workspace: unknown) => planWorktree(stringArg(workspace, 'folder')))

  ctx.handle(IPC.worktreeAttach, async (id: unknown, request: unknown) => {
    const conversationId = ctx.taskIdArg(id)
    const conversation = conversationRepo.get(conversationId)
    if (!conversation) throw new Error('Task was not found.')
    if (conversation.worktree) throw new Error('This task already has a worktree.')
    const { workspace, copy, raceId, title } = (request ?? {}) as { workspace?: unknown; copy?: unknown; raceId?: unknown; title?: unknown }
    const made = await createWorktree({
      workspace: stringArg(workspace, 'folder'),
      copy: stringList(copy, 32),
      ...(typeof raceId === 'string' && raceId ? { raceId: raceId.slice(0, 64) } : {}),
      ...(typeof title === 'string' ? { title } : {})
    })
    if (!made.ok) throw new Error(made.reason)
    conversationRepo.update(conversationId, { worktree: made.worktree, workspacePath: made.workspacePath })
    return conversationRepo.get(conversationId)
  })

  // The commands are what the person has just read and agreed to, in a dialog or on the compare page.
  const runCommands = async (id: unknown, commands: unknown): Promise<WorktreeCommandResult[]> => {
    const { conversation, worktree } = worktreeOf(id)
    const results: WorktreeCommandResult[] = []
    for (const command of stringList(commands, MAX_COMMANDS)) {
      const manager = ctx.chat.processManager
      const started = await manager.start({
        conversationId: conversation.id,
        command,
        cwd: conversation.workspacePath ?? worktree.path,
        spec: resolveShell(getSettings().shell?.preferred ?? 'auto'),
        background: false,
        yieldMs: COMMAND_TIMEOUT_MS,
        timeoutMs: COMMAND_TIMEOUT_MS
      })
      // The manager hands back early for a long command, so keep asking until it has finished.
      let read = await manager.getOutput(started.task.id).catch(() => undefined)
      while (read?.task.status === 'running') read = await manager.getOutput(started.task.id, 30_000).catch(() => undefined)
      const finished = read?.task ?? started.task
      const ok = finished.status === 'exited' && finished.exitCode === 0
      results.push({ command, ok, exitCode: finished.exitCode ?? null, output: (read?.text ?? started.initialOutput).slice(-OUTPUT_TAIL) })
      if (!ok) break
    }
    return results
  }
  ctx.handle(IPC.worktreeRun, runCommands)
  ctx.handle(IPC.worktreeSetup, async (id: unknown, commands: unknown) => {
    const results = await runCommands(id, commands)
    const { conversation, worktree } = worktreeOf(id)
    conversationRepo.update(conversation.id, { worktree: await withBaseline(worktree) })
    return results
  })

  ctx.handle(IPC.worktreeDiff, (id: unknown) => worktreeDiff(worktreeOf(id).worktree))
  ctx.handle(IPC.worktreeApply, (id: unknown) => applyWorktree(worktreeOf(id).worktree))

  ctx.handle(IPC.worktreeDiscard, async (id: unknown) => {
    const { conversation, worktree } = worktreeOf(id)
    assertIdle(ctx, conversation.id)
    // Whatever it left running holds the folder open.
    await ctx.chat.processManager.deleteConversation(conversation.id)
    const removed = await removeWorktree(worktree)
    if (removed.ok) conversationRepo.update(conversation.id, { worktree: { ...worktree, removedAt: Date.now() }, workspacePath: undefined })
    return removed
  })

  ctx.handle(IPC.raceRuns, async (raceId: unknown): Promise<RaceRun[]> => {
    const wanted = stringArg(raceId, 'race', 64)
    const members = conversationRepo.listSummaries().filter((summary) => summary.worktree?.raceId === wanted && !summary.worktree.removedAt)
    return Promise.all(members.map(async (member) => {
      const cost = usageRepo.costOfConversation(member.id)
      return {
        conversationId: member.id,
        title: member.title,
        ...(member.providerId ? { providerId: member.providerId } : {}),
        ...(member.model ? { model: member.model } : {}),
        worktree: member.worktree!,
        summary: await summarizeWorktree(member.worktree!),
        ...(cost !== undefined ? { costUsd: cost } : {})
      }
    }))
  })

  ctx.handle(IPC.worktreeChecks, (id: unknown) => {
    const { conversation, worktree } = worktreeOf(id)
    return detectCheckCommands(conversation.workspacePath ?? worktree.path).map((entry) => entry.command)
  })
}
