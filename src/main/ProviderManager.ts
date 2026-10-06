import { createProvider, type EffortModel } from '@core/providers'
import type { AIProvider, ModelInfo, ProviderConfig, ValidationResult } from '@core/types'
import { NormalizedAIError } from '@core/types'
import { ModelRegistry } from '@core/registry'
import type { ModelRefreshResult } from '@shared/ipc'
import { providerRepo } from './db'
import { getSecret } from './credentials'
import { getSettings } from './config'
import { logger } from './logger'
import { connectionChecked, connectionFix, modelNoun } from './providerDiagnosis'
import { catalogEffortModel, catalogModelInfo, catalogProviderId, enrichModels, type CatalogReader } from './modelMetadata'
import { declaredLongContextModels, declaredModelInfo, declaresLongContext, markLongContext, markLongContextModels } from '@shared/longContext'

export interface ProviderManagerOptions {
  /** Where model metadata that a provider does not report comes from. Optional: without it models are listed as reported. */
  catalog?: CatalogReader & { ready(timeoutMs: number): Promise<void> }
}

/** The first model list waits this long for a catalog that has never been downloaded, and no longer. */
const CATALOG_FIRST_USE_WAIT_MS = 3_500

/**
 * Owns the set of live provider instances built from stored configs + resolved
 * secrets. The AIGateway resolves providers through this manager, so the rest of
 * the app is fully provider-agnostic.
 */
export class ProviderManager {
  private readonly instances = new Map<string, AIProvider>()
  readonly registry = new ModelRegistry()

  constructor(private readonly options: ProviderManagerOptions = {}) {}

  /** (Re)build a provider instance from its stored config. */
  private build(cfg: ProviderConfig): AIProvider | undefined {
    if (!cfg.enabled) return undefined
    try {
      const secret = resolveSecret(cfg)
      const provider = createProvider(cfg, secret, { modelInfo: (modelId) => this.knownModel(cfg, modelId) })
      this.instances.set(cfg.id, provider)
      return provider
    } catch (err) {
      logger.error(`Failed to build provider ${cfg.id}: ${(err as Error).message}`, { provider: cfg.id })
      return undefined
    }
  }

  /** Resolver passed to AIGateway. Lazily builds instances. */
  resolve = (providerId: string): AIProvider | undefined => {
    // Check current settings before using an already-built adapter. Gateway
    // retries and fallbacks resolve again, so a toggle takes effect on the next
    // attempt without interrupting requests that are already in flight.
    const cfg = providerRepo.get(providerId)
    if (!cfg?.enabled) return undefined
    if (getSettings().privacy.localOnly && !isLocalProvider(cfg)) {
      throw new NormalizedAIError({
        provider: providerId,
        category: 'AUTHORIZATION_ERROR',
        classification: 'permanent',
        retryable: false,
        rawCode: 'LOCAL_ONLY_MODE',
        message: `Local-only mode blocks model requests to "${cfg.name}". Select a local runtime or an endpoint configured for local access, or turn off local-only mode in Settings.`
      })
    }
    const existing = this.instances.get(providerId)
    if (existing) return existing
    return this.build(cfg)
  }

  /** Called after a config changes so the next call picks up new settings. */
  invalidate(providerId: string): void {
    this.instances.delete(providerId)
  }

  /**
   * What is known about one model: its listed entry once the provider has been asked, otherwise the catalog's, with
   * a declared 1M option added when the person named that model on the provider.
   */
  private knownModel(cfg: ProviderConfig, modelId: string): EffortModel | undefined {
    const found = this.registry.get(cfg.id, modelId) ?? catalogEffortModel(cfg, modelId, this.options.catalog)
    // The adapters read this to decide what the model accepts; `id` is all they need for the rest.
    return found ? { ...found, ...(declaresLongContext(cfg, modelId) ? { longContextBeta: true } : {}) } : undefined
  }

  /**
   * The provider's model list with the catalog's metadata merged in and the models the person declared as offering a
   * 1M window marked. The declared models the provider did not list are added, so a model nobody has loaded yet can
   * still be picked in chat. A catalog that has never been downloaded is waited for briefly, once; local-only mode
   * never asks for it and uses only what is already on disk.
   */
  private async fetchModels(provider: AIProvider, cfg: ProviderConfig): Promise<ModelInfo[]> {
    const catalog = this.options.catalog
    if (catalog && !getSettings().privacy.localOnly) await catalog.ready(CATALOG_FIRST_USE_WAIT_MS).catch(() => undefined)
    const listed = markLongContextModels(cfg, enrichModels(cfg, await provider.getModels(), catalog))
    if (!catalog || declaredLongContextModels(cfg).length === 0) return listed
    const providerId = catalogProviderId(cfg, catalog)
    const declared = declaredLongContextModels(cfg)
      .filter((id) => !listed.some((model) => model.id.toLowerCase() === id.toLowerCase()))
      .map((id) => declaredModelInfo(cfg, id, providerId ? catalog.lookup(providerId, id) : undefined))
      .filter((model): model is ModelInfo => model !== undefined)
    return declared.length > 0 ? [...listed, ...declared] : listed
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const provider = this.resolve(providerId)
    const cfg = providerRepo.get(providerId)
    if (!provider || !cfg) return []
    try {
      const models = await this.fetchModels(provider, cfg)
      this.registry.replaceProvider(providerId, models)
      return models
    } catch (err) {
      logger.warn(`getModels failed for ${providerId}: ${(err as Error).message}`, { provider: providerId })
      return this.registry.byProvider(providerId)
    }
  }

  /**
   * What a request needs to know about its model: the window it can fill and what it costs. The listed entry when
   * the provider has been asked, and the catalog's when it has not or its list could not be fetched, so the context
   * meter and the cost do not depend on a model list that happened to load.
   */
  getModelInfo(providerId: string, modelId: string): ModelInfo | undefined {
    const cfg = providerRepo.get(providerId)
    const listed = this.registry.get(providerId, modelId)
    if (listed) return cfg ? markLongContext(cfg, listed) : listed
    if (!cfg) return undefined
    // The catalog's entry when it has one — the declared 1M option added to it — and otherwise the declared model
    // itself, so a model the provider never listed is still described enough to be picked in chat.
    const known = catalogModelInfo(cfg, modelId, this.options.catalog)
    if (known) return markLongContext(cfg, known)
    return declaredModelInfo(cfg, modelId, undefined)
  }

  /**
   * Check a provider the way a chat would reach it. A success carries how long the
   * provider took, what the check did, and how many models it offers; a failure
   * carries what to try next. The model list it fetched replaces the known one.
   */
  async test(providerId: string): Promise<ValidationResult> {
    try {
      const provider = this.resolve(providerId)
      const cfg = providerRepo.get(providerId)
      if (!provider || !cfg) return { ok: false, message: 'This provider is turned off. Turn it on, then test again.' }
      const started = Date.now()
      const result = await provider.validateConfiguration()
      const latencyMs = Date.now() - started
      if (!result.ok) return { ...result, details: { ...result.details, latencyMs, fix: connectionFix(cfg, result.message) } }
      return { ...result, details: { ...result.details, latencyMs, checked: connectionChecked(cfg), ...(await this.countModels(provider, cfg)) } }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }

  /**
   * Fetch the model list again. The provider is checked first because several
   * adapters answer a failed list with their built-in one, which would otherwise
   * read as a successful refresh.
   */
  async refreshModels(providerId: string): Promise<ModelRefreshResult> {    const known = (): number => this.registry.byProvider(providerId).length
    try {
      const provider = this.resolve(providerId)
      const cfg = providerRepo.get(providerId)
      if (!provider || !cfg) return { ok: false, count: known(), message: 'This provider is turned off. Turn it on, then refresh the models.' }
      const check = await provider.validateConfiguration()
      if (!check.ok) {
        return { ok: false, count: known(), message: check.message ?? 'The provider did not answer.', fix: connectionFix(cfg, check.message) }
      }
      const models = await this.fetchModels(provider, cfg)
      this.registry.replaceProvider(providerId, models)
      return { ok: true, count: models.length }
    } catch (err) {
      return { ok: false, count: known(), message: (err as Error).message }
    }
  }

  /** The models a reachable provider offers, and whether the one this provider defaults to is among them. */
  private async countModels(provider: AIProvider, cfg: ProviderConfig): Promise<Record<string, unknown>> {
    try {
      const models = await this.fetchModels(provider, cfg)
      this.registry.replaceProvider(cfg.id, models)
      const wanted = cfg.defaultModel?.trim()
      return {
        models: models.length,
        modelNoun: modelNoun(cfg),
        ...(wanted && models.length > 0 ? { defaultModelListed: models.some((m) => m.id === wanted) } : {})
      }
    } catch (err) {
      logger.warn(`getModels failed for ${cfg.id}: ${(err as Error).message}`, { provider: cfg.id })
      return {}
    }
  }
}

/** Local access is a declared model-routing policy, not a network firewall. */
function isLocalProvider(cfg: ProviderConfig): boolean {
  switch (cfg.kind) {
    case 'mock':
    case 'mock-local':
    case 'ollama':
    case 'lmstudio':
    case 'llamacpp':
      return true
    case 'custom':
    case 'openai-compat':
      // Azure OpenAI is always a cloud endpoint, whatever the config declares.
      return cfg.accessType === 'local' && cfg.apiMode !== 'azure'
    default:
      // Native cloud adapters cannot bypass the policy by changing accessType.
      return false
  }
}

/** Resolve the secret for a provider config from the encrypted store or env. */
function resolveSecret(cfg: ProviderConfig): string | undefined {
  // Explicit stored ref wins.
  const fromRef = getSecret(cfg.credentialRef)
  if (fromRef) return fromRef
  // Developer env-var fallbacks by kind.
  const settings = getSettings()
  switch (cfg.kind) {
    case 'openai':
      return process.env.CUBEX_OPENAI_API_KEY
    case 'anthropic':
      return process.env.CUBEX_ANTHROPIC_API_KEY
    case 'gemini':
      return process.env.CUBEX_GEMINI_API_KEY
    case 'openai-compat':
      return process.env.CUBEX_OPENAI_COMPAT_API_KEY
    case 'ollama':
      return undefined // local, no secret
    default:
      void settings
      return undefined
  }
}
