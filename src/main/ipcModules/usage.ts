import { IPC, type UsageReport } from '@shared/ipc'
import { getSettings } from '../config'
import type { ModelInfo } from '@core/types'
import { repriceUnpriced } from '../cost'
import { providerRepo, usageRepo } from '../db'
import { knownPrice } from '../knownPricing'
import { logger } from '../logger'
import { buildUsageReport } from '../usageReport'
import type { IpcContext } from './context'

/** A provider deleted since: its model is still priced by name. A provider that still exists answers for itself. */
function pricedByName(providerId: string, model: string): ModelInfo | undefined {
  if (providerRepo.get(providerId)) return undefined
  const pricing = knownPrice(model)
  return pricing ? { id: model, providerId, displayName: model, location: 'cloud', capabilities: [], modalities: { input: ['text'], output: ['text'] }, supportsTools: true, supportsStructuredOutput: false, supportsReasoning: false, pricing } : undefined
}

export function register(ctx: IpcContext): void {
  let repriced = false
  // The task is optional: without one the report has the day and its caps, and no session or turn meters.
  ctx.handle(IPC.getUsageReport, (conversationId?: unknown): UsageReport => {
    // Once per run, when the report is first wanted: requests from before their model had a price join the totals.
    if (!repriced) {
      repriced = true
      try {
        repriceUnpriced(usageRepo, (providerId, model) => ctx.providers.getModelInfo(providerId, model) ?? pricedByName(providerId, model))
      } catch (error) {
        logger.warn(`Could not price past requests: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const task = conversationId === undefined || conversationId === null ? undefined : ctx.taskIdArg(conversationId)
    return buildUsageReport({ source: usageRepo, budget: getSettings().ai?.budget, spend: ctx.chat.budgetSnapshot(task) })
  })
}
