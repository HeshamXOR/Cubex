import type { Usage } from '@core/types'

/**
 * Context accounting anchored on what the provider actually reported.
 *
 * `estimateContextUsage` is a heuristic; the input-token count on every
 * response is ground truth for everything that was really sent, including
 * reasoning blocks the provider retains and anything a gateway added after we
 * took our estimate. So we keep the last reported count per task and, for the
 * next request, add an estimate of only what has been appended since it. The
 * pure estimate remains the fallback: the first turn of a task, a provider
 * that reports nothing, and any point where the anchor has gone stale.
 */

/** The last provider measurement for a task, paired with our estimate of the same request. */
export interface AnchorReport {
  /** Total input tokens the provider reported, cache reads and writes included. */
  inputTokens: number
  /** What `estimateContextUsage` made of that exact request, so a later delta is comparable. */
  estimatedAtReport: number
}

/** Which measurement the number rests on, so the meter can say so. */
export type ContextBasis = 'anchored' | 'estimated'

export interface AnchoredContext {
  tokens: number
  basis: ContextBasis
  /** The reported count the number rests on. Present only when anchored. */
  anchorTokens?: number
  /** Estimated tokens appended since that report. Present only when anchored. */
  appendedTokens?: number
}

/**
 * One odd report must not explode the delta, so the observed estimator drift is
 * capped. It is never allowed below 1: the estimator under-counting is the
 * failure we are correcting, and scaling the delta down would reintroduce it.
 */
const MAX_DRIFT_FACTOR = 2
/**
 * How far the estimate may fall below the anchored request before the anchor is
 * abandoned. Tool-result pruning trims a little; a compaction removes most of
 * the history, and then the reported count describes a conversation that no
 * longer exists.
 */
const SHRINK_TOLERANCE = 0.98

const usable = (value: number | undefined): boolean => value !== undefined && Number.isFinite(value) && value > 0

/** The drift the last turn revealed, applied to the tokens appended since it. */
function driftFactor(report: AnchorReport): number {
  const ratio = report.inputTokens / report.estimatedAtReport
  if (!Number.isFinite(ratio)) return 1
  return Math.min(MAX_DRIFT_FACTOR, Math.max(1, ratio))
}

/**
 * The working context size for a request whose full estimate is
 * `estimatedTokens`, given the last provider measurement for the same task.
 */
export function anchoredContextTokens(estimatedTokens: number, report: AnchorReport | undefined): AnchoredContext {
  const estimated = Number.isFinite(estimatedTokens) ? Math.max(0, Math.ceil(estimatedTokens)) : 0
  if (!report || !usable(report.inputTokens) || !usable(report.estimatedAtReport)) {
    return { basis: 'estimated', tokens: estimated }
  }
  if (estimated < report.estimatedAtReport * SHRINK_TOLERANCE) return { basis: 'estimated', tokens: estimated }
  const appendedTokens = Math.ceil(Math.max(0, estimated - report.estimatedAtReport) * driftFactor(report))
  return {
    basis: 'anchored',
    tokens: report.inputTokens + appendedTokens,
    anchorTokens: report.inputTokens,
    appendedTokens
  }
}

/**
 * Per-task anchors. Held in memory only: a restart simply starts from the pure
 * estimate again and re-anchors on the first response.
 */
export class ContextAnchorStore {
  private readonly reports = new Map<string, AnchorReport>()

  record(conversationId: string, report: AnchorReport): void {
    this.reports.set(conversationId, report)
  }

  /**
   * Fold a finished response into the anchor. `inputTokens` is already the full
   * input context on every adapter here, so the cache subsets are summed only
   * when a provider reported them without a total.
   */
  recordUsage(conversationId: string, usage: Usage | undefined, estimatedAtReport: number): void {
    if (!usage) return
    const cached = (usage.cachedInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
    const inputTokens = usable(usage.inputTokens) ? usage.inputTokens! : cached
    if (!usable(inputTokens) || !usable(estimatedAtReport)) return
    this.record(conversationId, { inputTokens: Math.floor(inputTokens), estimatedAtReport: Math.ceil(estimatedAtReport) })
  }

  get(conversationId: string): AnchorReport | undefined {
    return this.reports.get(conversationId)
  }

  resolve(conversationId: string, estimatedTokens: number): AnchoredContext {
    return anchoredContextTokens(estimatedTokens, this.reports.get(conversationId))
  }

  forget(conversationId: string): void {
    this.reports.delete(conversationId)
  }
}
