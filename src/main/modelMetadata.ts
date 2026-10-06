import type { Capability, ModelInfo, ProviderConfig } from '@core/types'
import type { EffortModel } from '@core/providers'
import type { CatalogModel } from './modelCatalog'

/**
 * Fills in what a provider's own model list leaves out, from the model catalog: the context window, the output
 * limit, a price, whether the model reasons and which effort levels it takes. A compatible endpoint lists model ids
 * and nothing else, so without this a model served through NVIDIA, OpenRouter or Groq has no context meter, no cost
 * and often no effort control.
 *
 * What the provider reported always wins. The catalog only fills gaps, and it never turns a capability off.
 */

/** The part of the catalog this module reads, so a test can supply a small one. */
export interface CatalogReader {
  lookup(providerId: string, modelId: string): CatalogModel | undefined
  providerForHost(host: string): string | undefined
}

/**
 * Hosts of the providers Cubex has presets for. The catalog lists no address for most of them, so these are named
 * here; any other host is matched through the address the catalog does list.
 */
const KNOWN_HOSTS: Readonly<Record<string, string>> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.groq.com': 'groq',
  'api.together.ai': 'togetherai',
  'api.together.xyz': 'togetherai',
  'api.mistral.ai': 'mistral',
  'api.x.ai': 'xai',
  'api.deepseek.com': 'deepseek',
  'openrouter.ai': 'openrouter',
  'integrate.api.nvidia.com': 'nvidia'
}

/** A native adapter's default endpoint, for a config that does not set a base URL. */
const DEFAULT_PROVIDER: Readonly<Partial<Record<ProviderConfig['kind'], string>>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google'
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const isLoopbackOrPrivate = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || host === '::1' || /^172\.(1[6-9]|2\d|3[01])\./.test(host)

/**
 * The catalog provider a config talks to, or undefined when none can be named with confidence. Local runtimes, the
 * custom kinds and Azure (whose "models" are deployment names the owner chose) are never matched.
 */
export function catalogProviderId(cfg: ProviderConfig, catalog: Pick<CatalogReader, 'providerForHost'>): string | undefined {
  if (cfg.kind === 'ollama' || cfg.kind === 'lmstudio' || cfg.kind === 'llamacpp' || cfg.kind === 'custom' || cfg.kind === 'mock' || cfg.kind === 'mock-local') return undefined
  if (cfg.kind === 'openai-compat' && cfg.apiMode === 'azure') return undefined
  const host = hostOf(cfg.baseUrl)
  if (!host) return DEFAULT_PROVIDER[cfg.kind]
  if (isLoopbackOrPrivate(host)) return undefined
  return KNOWN_HOSTS[host] ?? catalog.providerForHost(host)
}

/** One model of a provider's list with the catalog's entry merged in. */
export function enrichModel(model: ModelInfo, known: CatalogModel | undefined): ModelInfo {
  if (!known) return model
  const capabilities: Capability[] = known.supportsReasoning && !model.capabilities.includes('reasoning') ? [...model.capabilities, 'reasoning'] : model.capabilities
  return {
    ...model,
    capabilities,
    supportsReasoning: model.supportsReasoning || known.supportsReasoning,
    ...(model.contextWindow === undefined && known.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
    ...(model.maxInputTokens === undefined && known.maxInputTokens !== undefined ? { maxInputTokens: known.maxInputTokens } : {}),
    ...(model.maxOutputTokens === undefined && known.maxOutputTokens !== undefined ? { maxOutputTokens: known.maxOutputTokens } : {}),
    ...(model.reasoningEfforts === undefined && known.reasoningEfforts !== undefined ? { reasoningEfforts: known.reasoningEfforts } : {}),
    ...(model.pricing === undefined && known.pricing ? { pricing: known.pricing } : {}),
    ...(model.family === undefined && known.family ? { family: known.family } : {})
  }
}

/** A provider's model list with the catalog's entries merged in. The list comes back unchanged when nothing matches. */
export function enrichModels(cfg: ProviderConfig, models: ModelInfo[], catalog: CatalogReader | undefined): ModelInfo[] {
  if (!catalog) return models
  const providerId = catalogProviderId(cfg, catalog)
  if (!providerId) return models
  return models.map((model) => enrichModel(model, catalog.lookup(providerId, model.id)))
}

/**
 * What the catalog says about a model the provider was never asked to list (or could not list), as a model entry: the
 * window, the output limit and the price that a request and its cost need. It is a cloud entry by construction, since
 * a local runtime or a private address is never matched.
 */
export function catalogModelInfo(cfg: ProviderConfig, modelId: string, catalog: CatalogReader | undefined): ModelInfo | undefined {
  if (!catalog) return undefined
  const providerId = catalogProviderId(cfg, catalog)
  const known = providerId ? catalog.lookup(providerId, modelId) : undefined
  if (!known) return undefined
  return enrichModel({
    id: modelId, providerId: cfg.id, displayName: known.displayName || modelId, location: 'cloud', capabilities: ['text'],
    modalities: { input: ['text'], output: ['text'] }, supportsTools: known.supportsTools, supportsStructuredOutput: false, supportsReasoning: false
  }, known)
}

/**
 * What the catalog says about a model, in the shape an adapter reads when it checks a request. It is the same
 * answer `enrichModels` gives, for a model that was never listed.
 */
export function catalogEffortModel(cfg: ProviderConfig, modelId: string, catalog: CatalogReader | undefined): EffortModel | undefined {
  if (!catalog) return undefined
  const providerId = catalogProviderId(cfg, catalog)
  const known = providerId ? catalog.lookup(providerId, modelId) : undefined
  if (!known) return undefined
  return { id: modelId, supportsReasoning: known.supportsReasoning, ...(known.reasoningEfforts !== undefined ? { reasoningEfforts: known.reasoningEfforts } : {}) }
}
