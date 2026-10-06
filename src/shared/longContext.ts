import type { ModelInfo, ProviderConfig } from '@core/types'

/**
 * The 1M context option. A provider that gates its largest window behind a beta — Anthropic's `context-1m` — reports
 * or lists only the ordinary window, so nothing in a plain model list says the bigger one exists. A person declares
 * which models offer it, once, on the provider; every listed entry for those models is then marked the same way and
 * the composer and the details panel offer the switch.
 *
 * Marking an entry `longContextBeta` is what tells the rest of the app there is a bigger window to unlock: the model
 * keeps its ordinary size until the switch is on, and the per-request header is what asks the provider for it
 * (see `effectiveContextWindow` in contextUsage.ts and `betaHeaders` in the Anthropic adapter).
 */

/** How many models one provider may declare. A generous ceiling that keeps a saved config bounded. */
export const MAX_LONG_CONTEXT_MODELS = 50
/** A window this large is the gated one itself, not the ordinary window a 1M model is listed with. */
const ALREADY_LONG_CONTEXT = 500_000

const clean = (value: string): string => value.trim()
const lowered = (value: string): string => clean(value).toLowerCase()

/** The models a provider config declares as offering 1M, trimmed, without duplicates, bounded. */
export function declaredLongContextModels(cfg: Pick<ProviderConfig, 'longContextModels'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of cfg.longContextModels ?? []) {
    const id = clean(entry)
    if (!id || seen.has(lowered(id))) continue
    seen.add(lowered(id))
    out.push(id)
  }
  return out.slice(0, MAX_LONG_CONTEXT_MODELS)
}

export function declaresLongContext(cfg: Pick<ProviderConfig, 'longContextModels'>, modelId: string): boolean {
  const wanted = lowered(modelId)
  return declaredLongContextModels(cfg).some((id) => lowered(id) === wanted)
}

/** The list as it is stored: trimmed, deduplicated, and left out entirely when nothing remains. */
export function normalizeLongContextModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const cleaned = declaredLongContextModels({ longContextModels: value.map((entry) => (typeof entry === 'string' ? entry : '')) })
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Whether a declared model's listed entry still needs the switch. A model already sized at the gated window has
 * nothing left to add, and one the provider or the catalog reports larger than that is not gated at all.
 */
function needsEntry(cfg: Pick<ProviderConfig, 'longContextModels'>, model: Pick<ModelInfo, 'id' | 'contextWindow'>): boolean {
  if (!declaresLongContext(cfg, model.id)) return false
  const window = model.contextWindow
  return window === undefined || window < ALREADY_LONG_CONTEXT
}

/** One listed model with the declared 1M option applied. A model the person did not declare comes back unchanged. */
export function markLongContext(cfg: Pick<ProviderConfig, 'longContextModels'>, model: ModelInfo): ModelInfo {
  if (!needsEntry(cfg, model)) return model
  return { ...model, longContextBeta: true }
}

/** A provider's model list with the declared 1M option applied to the models named on it. */
export function markLongContextModels(cfg: Pick<ProviderConfig, 'longContextModels'>, models: ModelInfo[]): ModelInfo[] {
  if (declaredLongContextModels(cfg).length === 0) return models
  return models.map((model) => markLongContext(cfg, model))
}

/**
 * The part of a catalog entry this module reads. Declared here rather than imported so the window can use the same
 * helpers as main without pulling the catalog's Node-only code along.
 */
export interface KnownCatalogModel {
  displayName?: string
  family?: string
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsReasoning?: boolean
  /** The effort levels the catalog lists, lowest first. */
  reasoningEfforts?: readonly string[]
  capabilities?: readonly string[]
  pricing?: ModelInfo['pricing']
}

/**
 * A declared model the provider never listed, as an entry the composer can select. Its window comes from the catalog
 * when the catalog has one — the model keeps the ordinary size until the switch is on, exactly like a listed entry —
 * and stays unknown otherwise: a made-up size would clamp the very requests the option exists for.
 */
export function declaredModelInfo(cfg: ProviderConfig, modelId: string, known: KnownCatalogModel | undefined): ModelInfo | undefined {
  if (!declaresLongContext(cfg, modelId)) return undefined
  return {
    id: clean(modelId),
    providerId: cfg.id,
    displayName: known?.displayName || clean(modelId),
    location: 'cloud',
    capabilities: (known?.capabilities as ModelInfo['capabilities']) ?? ['text'],
    modalities: { input: ['text'], output: ['text'] },
    supportsTools: known?.supportsTools ?? true,
    supportsStructuredOutput: false,
    supportsReasoning: known?.supportsReasoning ?? false,
    ...(known?.family ? { family: known.family } : {}),
    ...(known?.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
    ...(known?.maxInputTokens !== undefined ? { maxInputTokens: known.maxInputTokens } : {}),
    ...(known?.maxOutputTokens !== undefined ? { maxOutputTokens: known.maxOutputTokens } : {}),
    ...(known?.reasoningEfforts !== undefined ? { reasoningEfforts: [...known.reasoningEfforts] as ModelInfo['reasoningEfforts'] } : {}),
    ...(known?.pricing ? { pricing: known.pricing } : {}),
    longContextBeta: true
  }
}
