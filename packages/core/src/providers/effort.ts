import type { ProviderKind } from '../types/provider'
import type { AIRequest, ReasoningEffort } from '../types/request'
import type { ModelInfo } from '../types/model'
import { geminiEffortChoices } from './gemini/thinking'
/**
 * Which reasoning-effort options a provider exposes, and how to label them, so
 * the UI can present provider-appropriate controls instead of a generic list.
 * The stored value is always a unified `ReasoningEffort`; adapters map it to the
 * provider's native parameter (see each adapter's translate.ts).
 */
export interface EffortOption {
  /** Undefined leaves reasoning behavior to the provider. */
  value: ReasoningEffort | undefined
  label: string
  hint: string
}

/** The selected id is still available while its metadata is loading. */
export type EffortModel = Pick<ModelInfo, 'id'> & Partial<Pick<ModelInfo, 'supportsReasoning' | 'reasoningEfforts'>>

const DEFAULT_EFFORT: EffortOption = {
  value: undefined, label: 'Default', hint: 'Use the model default; send no effort parameter'
}

const ANTHROPIC_EFFORTS: EffortOption[] = [
  { value: 'low', label: 'Low', hint: 'Fast, minimal thinking' },
  { value: 'medium', label: 'Medium', hint: 'Balanced (recommended)' },
  { value: 'high', label: 'High', hint: 'Deeper reasoning' },
  { value: 'xhigh', label: 'Extra High', hint: 'Best for coding/agentic work' },
  { value: 'max', label: 'Max', hint: 'Correctness over cost' }
]

const OPENAI_EFFORTS: EffortOption[] = [
  { value: 'minimal', label: 'Minimal', hint: 'GPT-5 family; fastest' },
  { value: 'low', label: 'Low', hint: 'Fast responses' },
  { value: 'medium', label: 'Medium', hint: 'Balanced (recommended)' },
  { value: 'high', label: 'High', hint: 'Deeper reasoning' },
  { value: 'xhigh', label: 'Extra High', hint: 'GPT-6 / 5.6; agentic work' },
  { value: 'max', label: 'Max', hint: 'GPT-6 / 5.6; correctness over cost' }
]

/** Labels for efforts a model reports itself, so any list a catalog gives can be shown. */
const EFFORT_LABELS: Record<ReasoningEffort, Pick<EffortOption, 'label' | 'hint'>> = {
  minimal: { label: 'Minimal', hint: 'Fastest; barely any reasoning' },
  low: { label: 'Low', hint: 'Fast responses' },
  medium: { label: 'Medium', hint: 'Balanced (recommended)' },
  high: { label: 'High', hint: 'Deeper reasoning' },
  xhigh: { label: 'Extra High', hint: 'Very deep reasoning' },
  max: { label: 'Max', hint: 'Correctness over cost' }
}

const EFFORT_ORDER: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The options for a list of efforts a model reported, in order, behind the default. */
function reportedEfforts(efforts: readonly ReasoningEffort[]): EffortOption[] {
  return EFFORT_ORDER.filter((value) => efforts.includes(value)).map((value) => ({ value, ...EFFORT_LABELS[value] }))
}

/**
 * Model families that reason, recognised by id. An OpenAI-compatible endpoint
 * reports nothing about reasoning in its `/models` listing, so without this a
 * reasoning model served through NVIDIA, OpenRouter, Groq or Together would
 * offer no effort control at all. Explicit metadata and a user-declared
 * capability always win over this list; it only fills the silence.
 */
const REASONING_IDS = [
  /(^|[^a-z])r1([^0-9]|$)/,          // deepseek-r1 and its distills
  /deepseek-(r\d|reasoner)/,
  /qwq/,
  /qwen-?3/,                          // Qwen3 reasons by default
  /gpt-oss/,
  /kimi-k(2\.[5-9]|[3-9])/,           // Kimi K2.5 and later think by default
  /nemotron/,                         // NVIDIA reasoning builds
  /glm-(z1|4\.[5-9]|[5-9])/,
  /minimax-m\d/,
  /magistral/,
  /phi-4-reasoning/,
  /exaone-deep/,
  /seed-oss/,
  /hunyuan-t\d/,
  /ernie-x\d/,
  /(thinking|reasoner|reasoning)/,
  /(^|\/)o[1-9](-|$)/                 // o-series behind a compatible gateway
]

/** Whether a model id looks like a reasoning model. Never overrides real metadata. */
export function infersReasoning(id: string): boolean {
  const normalized = id.toLowerCase()
  return REASONING_IDS.some((pattern) => pattern.test(normalized))
}

/**
 * Options for the selected model. Explicit metadata wins over id heuristics.
 * Generic endpoints report no reasoning flag of their own, so a known
 * reasoning family is recognised by id; anything unrecognised stays hidden.
 * Unknown native models use the same family heuristics as their adapters
 * until metadata arrives. An empty array means the selector should be hidden.
 */
export function effortOptionsFor(kind: ProviderKind, model?: EffortModel): EffortOption[] {
  if (!model?.id) return []
  const id = model.id.toLowerCase()
  if (model.supportsReasoning === false && !isGenericKind(kind)) return []
  switch (kind) {
    case 'anthropic': {
      const supported = model.supportsReasoning ?? /fable-5|opus-5|opus-4|sonnet-5|sonnet-4|3-7-sonnet/.test(id)
      return supported ? [DEFAULT_EFFORT, ...ANTHROPIC_EFFORTS] : []
    }
    case 'openai': {
      const supported = model.supportsReasoning ?? /^(gpt-6|gpt-5|o1|o3|o4)/.test(id)
      if (!supported) return []
      // Offer only values the adapter can pass through for this model.
      const extended = /^gpt-(6|5\.6)/.test(id)
      return [DEFAULT_EFFORT, ...OPENAI_EFFORTS.filter(({ value }) => {
        if (value === 'minimal') return /^gpt-5/.test(id)
        if (value === 'xhigh' || value === 'max') return extended
        return true
      })]
    }
    case 'openai-compat':
    case 'lmstudio':
    case 'llamacpp':
      // What the model itself reports comes first, and an empty list is an answer: it reasons, but takes no effort.
      if (model.reasoningEfforts) {
        const reported = reportedEfforts(model.reasoningEfforts)
        return reported.length > 0 ? [DEFAULT_EFFORT, ...reported] : []
      }
      // A declared capability is authoritative; otherwise fall back to the id.
      return (model.supportsReasoning === true || infersReasoning(id))
        ? [DEFAULT_EFFORT, ...OPENAI_EFFORTS.filter(({ value }) => value === 'low' || value === 'medium' || value === 'high')]
        : []
    case 'gemini': {
      // Levels for Gemini 3, token budgets for 2.5, and only the values each model
      // accepts. gemini/thinking.ts owns the table; the adapter reads the same one.
      const choices = geminiEffortChoices(id, model.supportsReasoning)
      return choices.length > 0 ? [DEFAULT_EFFORT, ...choices.map(({ value, label, hint }) => ({ value, label, hint }))] : []
    }
    default:
      return []
  }
}

/**
 * Kinds whose model listings carry no reasoning flag, so a `false` there means
 * "not reported" rather than "not supported" and must not hide the control.
 */
function isGenericKind(kind: ProviderKind): boolean {
  return kind === 'openai-compat' || kind === 'lmstudio' || kind === 'llamacpp'
}

/**
 * What to say about a model's reasoning. A generic endpoint that lists no flag
 * and has no recognisable id is "unreported", not "no": telling someone their
 * model cannot reason because the server stayed silent would be a guess too.
 */
export function reasoningSupport(kind: ProviderKind | undefined, model: EffortModel): 'yes' | 'no' | 'unreported' {
  if (model.supportsReasoning === true) return 'yes'
  if (kind && effortOptionsFor(kind, model).length > 0) return 'yes'
  return kind && isGenericKind(kind) ? 'unreported' : 'no'
}

/** A sensible default effort for a provider kind (or undefined if none apply). */
export function defaultEffortFor(kind: ProviderKind, model?: EffortModel): ReasoningEffort | undefined {
  // Gemini's own default depends on the model (a dynamic budget on 2.5, a per-model
  // level on 3), so sending nothing is the right default there.
  if (kind === 'gemini') return undefined
  const opts = effortOptionsFor(kind, model)
  if (opts.length === 0) return undefined
  return opts.some((o) => o.value === 'medium') ? 'medium' : opts[0]!.value
}

/** Sanitize presets and stale selections before they reach a request. */
export function normalizeEffortFor(
  kind: ProviderKind,
  effort: ReasoningEffort | undefined,
  model?: EffortModel
): ReasoningEffort | undefined {
  if (effort === undefined) return undefined
  const options = effortOptionsFor(kind, model)
  if (options.some((option) => option.value === effort)) return effort
  // The nearest level the model offers. A tie goes to the lower one, which costs less.
  const rank = (value: ReasoningEffort): number => EFFORT_ORDER.indexOf(value)
  let nearest: ReasoningEffort | undefined
  for (const option of options) {
    if (option.value === undefined) continue
    if (nearest === undefined) { nearest = option.value; continue }
    const gap = Math.abs(rank(option.value) - rank(effort))
    const best = Math.abs(rank(nearest) - rank(effort))
    if (gap < best || (gap === best && rank(option.value) < rank(nearest))) nearest = option.value
  }
  return nearest
}

/**
 * Enforce the target adapter's effort support after routing/fallback merges.
 * Never mutate the original request: a later attempt may support its effort.
 */
export function requestWithSupportedEffort(kind: ProviderKind, request: AIRequest, model?: EffortModel): AIRequest {
  if (request.params?.reasoningEffort === undefined) return request
  const reasoningEffort = normalizeEffortFor(kind, request.params.reasoningEffort, model ?? { id: request.model })
  if (reasoningEffort === request.params.reasoningEffort) return request
  const params = { ...request.params }
  delete params.reasoningEffort
  if (reasoningEffort !== undefined) params.reasoningEffort = reasoningEffort
  return { ...request, params }
}
