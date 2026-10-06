import { IPC, type UsageReport } from '@shared/ipc'
import { getSettings } from '../config'
import { usageRepo } from '../db'
import { buildUsageReport } from '../usageReport'
import type { IpcContext } from './context'

export function register(ctx: IpcContext): void {
  // The task is optional: without one the report has the day and its caps, and no session or turn meters.
  ctx.handle(IPC.getUsageReport, (conversationId?: unknown): UsageReport => {
    const task = conversationId === undefined || conversationId === null ? undefined : ctx.taskIdArg(conversationId)
    return buildUsageReport({ source: usageRepo, budget: getSettings().ai?.budget, spend: ctx.chat.budgetSnapshot(task) })
  })
}
