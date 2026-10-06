import type { BudgetNotice, CubexAPI, UsagePeriod, UsageReport, UsageRow } from '../../../../shared/ipc'
import type { AppSettings, BudgetSettings } from '../../../../shared/settings'
import { budgetMeters } from '../../../../shared/budgetPolicy'
import { useContextCost } from '../../state/contextCost'
import type { PreviewSeed } from './index'

/**
 * Context management and spend for the browser preview. Flags, combined with `?seed=1&done=1`:
 *   compacting=1      a summary is being written on demand (the row at the end of the thread)
 *   compact=ok|fail|hold   what "Summarize earlier messages" does: finish with numbers, fail with a reason, or never finish
 *   usage=1           the usage popover has a normal week of spend, by provider and model, with a long model name
 *   budget=warn|over  caps are set and today's spend is 82% of one (warn) or past two (over), with the notice in the thread
 * Settings edits are kept in memory, so the Context summaries and Budget groups can be tried.
 */

const SUMMARY = ['## Goal', 'Make the upload client survive transient failures.', '', '## Decisions', '- Retry only 429 and 5xx.'].join('\n')

const row = (id: string, costUsd: number, requests: number, tokens: number, extra: Partial<UsageRow> = {}): UsageRow => ({ id, costUsd, requests, tokens, ...extra })

const TODAY: UsagePeriod = {
  costUsd: 4.12, requests: 30, tokens: 463_100,
  byProvider: [
    row('anthropic', 3.2, 14, 288_000),
    row('openai', 0.92, 9, 124_300, { estimated: true }),
    row('ollama', 0, 5, 41_000, { local: true }),
    row('nvidia', 0, 2, 9_800, { unpriced: true })
  ],
  byModel: [
    row('claude-opus-5-5', 2.6, 8, 201_000, { providerId: 'anthropic' }),
    row('claude-sonnet-4-5-20250929', 0.6, 6, 87_000, { providerId: 'anthropic' }),
    row('gpt-5.5', 0.92, 9, 124_300, { providerId: 'openai', estimated: true }),
    row('qwen3-coder:30b', 0, 5, 41_000, { providerId: 'ollama', local: true }),
    row('deepseek-ai/deepseek-r1-distill-llama-70b-instruct-fp8-turbo-latest', 0, 2, 9_800, { providerId: 'nvidia', unpriced: true })
  ]
}

/** The same shape at another size: every amount, request and token count is scaled, and costs are set to the target. */
function scaled(period: UsagePeriod, factor: number, costUsd = period.costUsd * factor): UsagePeriod {
  const ratio = costUsd / period.costUsd
  const grow = (rows: UsageRow[]): UsageRow[] => rows.map((entry) => ({
    ...entry, costUsd: entry.costUsd * ratio, requests: Math.round(entry.requests * factor), tokens: Math.round(entry.tokens * factor)
  }))
  return { costUsd, requests: Math.round(period.requests * factor), tokens: Math.round(period.tokens * factor), byProvider: grow(period.byProvider), byModel: grow(period.byModel) }
}

const BUDGETS: Record<string, { budget: BudgetSettings; today: number; session: number; notice: BudgetNotice }> = {
  warn: {
    budget: { dailyUsd: 5, perSessionUsd: 2, perTurnUsd: 0.5, action: 'stop' }, today: 4.12, session: 1.1,
    notice: {
      scope: 'daily', level: 'warn', action: 'stop', spentUsd: 4.12, limitUsd: 5, stopped: false,
      message: 'Daily spend is at 82% of the $5.00 budget ($4.12 so far). Cubex ends the turn at 100%. Raise it in Settings if you need more room.'
    }
  },
  over: {
    budget: { dailyUsd: 5, perSessionUsd: 2, perTurnUsd: 0.5, action: 'stop' }, today: 5.12, session: 2.4,
    notice: {
      scope: 'daily', level: 'over', action: 'stop', spentUsd: 5.12, limitUsd: 5, stopped: true,
      message: 'Daily budget of $5.00 reached. Raise it in Settings or wait until midnight.'
    }
  }
}

/** Plain objects merge key by key, anything else is replaced: what the main process does with a settings patch. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
      ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return out
}

let settings: Promise<AppSettings> | undefined
async function seededSettings(flags: URLSearchParams): Promise<AppSettings> {
  settings ??= (async () => {
    const { DEFAULT_SETTINGS } = await import('../../../../shared/settings')
    const { SEED_WORKSPACE } = await import('../previewSeed')
    const caps = BUDGETS[flags.get('budget') ?? '']
    return {
      ...DEFAULT_SETTINGS,
      general: { ...DEFAULT_SETTINGS.general, workspacePath: SEED_WORKSPACE, recentWorkspaces: [SEED_WORKSPACE, 'C:\\Users\\dev\\code\\aurora-site'] },
      ai: { ...DEFAULT_SETTINGS.ai, ...(caps ? { budget: caps.budget } : {}) }
    }
  })()
  return settings
}

export const seed: PreviewSeed = {
  state: (flags) => {
    const caps = BUDGETS[flags.get('budget') ?? '']
    if (caps) useContextCost.setState({ byConversation: { c1: { notices: [{ id: 'seed-budget', kind: 'budget', notice: caps.notice }] } } })
    return flags.has('compacting') ? { compactingId: 'c1' } : undefined
  },
  api: (flags) => {
    const caps = BUDGETS[flags.get('budget') ?? '']
    const compact = flags.get('compact')
    const api: Partial<CubexAPI> = {
      getSettings: () => seededSettings(flags),
      updateSettings: async (patch) => {
        const next = merge(await seededSettings(flags) as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppSettings
        settings = Promise.resolve(next)
        return next
      }
    }
    if (flags.has('usage') || caps) {
      api.getUsageReport = async (conversationId): Promise<UsageReport> => {
        const current = (await seededSettings(flags)).ai.budget
        const today = caps ? scaled(TODAY, 1, caps.today) : TODAY
        const spent = { daily: today.costUsd, ...(conversationId ? { session: caps?.session ?? 1.1 } : {}) }
        return {
          generatedAt: Date.now(), today, week: scaled(TODAY, 4.5, 18.4), month: scaled(TODAY, 14, 61.9),
          budget: { action: current?.action === 'stop' ? 'stop' : 'warn', meters: budgetMeters(current, spent), spent }
        }
      }
    }
    if (compact === 'ok') {
      api.compactConversation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        return { ok: true, summary: SUMMARY, boundaryMessageId: 'm1', messagesSummarized: 4, tokensBefore: 9_100, tokensAfter: 1_240 }
      }
    } else if (compact === 'fail') {
      api.compactConversation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 800))
        return { ok: false, error: 'The summary request failed: Provider unavailable' }
      }
    } else if (compact === 'hold') {
      api.compactConversation = () => new Promise(() => undefined)
    }
    return api
  }
}
