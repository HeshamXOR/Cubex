import { IPC } from '@shared/ipc'
import { normalizeStoredGoal, parseGoalEvaluateRequest } from '@shared/goal'
import { goalRepo } from '../db'
import type { IpcContext } from './context'

/**
 * Judging a chat's goal after each turn, and keeping the goal with its chat. The window's requests are untrusted: they
 * are read into bounded ones first, and a goal that is not one is refused with a sentence.
 */
export function register(ctx: IpcContext): void {
  ctx.handle(IPC.goalEvaluate, (request?: unknown) => ctx.chat.evaluateGoal(parseGoalEvaluateRequest(request)))
  ctx.handle(IPC.goalCancel, (conversationId?: unknown) => { ctx.chat.cancelGoalCheck(ctx.taskIdArg(conversationId)) })
  // Reading a goal never runs anything, and its check command is only handed to the window that shows it.
  ctx.handle(IPC.goalGet, (conversationId?: unknown) => goalRepo.get(ctx.taskIdArg(conversationId)) ?? null)
  ctx.handle(IPC.goalSet, (conversationId?: unknown, goal?: unknown) => {
    const id = ctx.taskIdArg(conversationId)
    if (goal === null || goal === undefined) return goalRepo.set(id, undefined)
    const stored = normalizeStoredGoal(goal)
    if (!stored) throw new Error('The goal could not be saved because it is empty, too long or not a goal.')
    goalRepo.set(id, stored)
  })
}
