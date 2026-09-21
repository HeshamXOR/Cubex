import type { ProviderKind } from '../types/provider'
import type { ReasoningEffort } from '../types/request'

/**
 * Which reasoning-effort options a provider exposes, and how to label them, so
 * the UI can present provider-appropriate controls instead of a generic list.
 * The stored value is always a unified `ReasoningEffort`; adapters map it to the
 * provider's native parameter (see each adapter's translate.ts).
 */
export interface EffortOption {
  value: ReasoningEffort
  label: string
  hint: string
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

/**
 * Effort options for a provider kind. Returns an empty array for providers with
 * no standardized effort/reasoning control (Ollama, generic OpenAI-compatible,
 * custom) — the UI then hides the effort selector.
 */
export function effortOptionsFor(kind: ProviderKind): EffortOption[] {
  switch (kind) {
    case 'anthropic':
      return ANTHROPIC_EFFORTS
    case 'openai':
      return OPENAI_EFFORTS
    // OpenAI-compatible servers *may* accept reasoning_effort, but we can't
    // assume it; expose the OpenAI set only when the user opts in per-model.
    case 'openai-compat':
    case 'lmstudio':
    case 'llamacpp':
      return OPENAI_EFFORTS
    default:
      return []
  }
}

/** A sensible default effort for a provider kind (or undefined if none apply). */
export function defaultEffortFor(kind: ProviderKind): ReasoningEffort | undefined {
  const opts = effortOptionsFor(kind)
  if (opts.length === 0) return undefined
  return opts.some((o) => o.value === 'medium') ? 'medium' : opts[0]!.value
}
