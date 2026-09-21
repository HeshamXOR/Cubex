import { createProvider } from '@core/providers'
import type { AIProvider, ModelInfo, ProviderConfig, ValidationResult } from '@core/types'
import { ModelRegistry } from '@core/registry'
import { providerRepo } from './db'
import { getSecret } from './credentials'
import { getSettings } from './config'
import { logger } from './logger'

/**
 * Owns the set of live provider instances built from stored configs + resolved
 * secrets. The AIGateway resolves providers through this manager, so the rest of
 * the app is fully provider-agnostic.
 */
export class ProviderManager {
  private readonly instances = new Map<string, AIProvider>()
  readonly registry = new ModelRegistry()

  /** (Re)build a provider instance from its stored config. */
  private build(cfg: ProviderConfig): AIProvider | undefined {
    if (!cfg.enabled) return undefined
    try {
      const secret = resolveSecret(cfg)
      const provider = createProvider(cfg, secret)
      this.instances.set(cfg.id, provider)
      return provider
    } catch (err) {
      logger.error(`Failed to build provider ${cfg.id}: ${(err as Error).message}`, { provider: cfg.id })
      return undefined
    }
  }

  /** Resolver passed to AIGateway. Lazily builds instances. */
  resolve = (providerId: string): AIProvider | undefined => {
    const existing = this.instances.get(providerId)
    if (existing) return existing
    const cfg = providerRepo.get(providerId)
    if (!cfg) return undefined
    return this.build(cfg)
  }

  /** Called after a config changes so the next call picks up new settings. */
  invalidate(providerId: string): void {
    this.instances.delete(providerId)
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const provider = this.resolve(providerId)
    if (!provider) return []
    try {
      const models = await provider.getModels()
      this.registry.replaceProvider(providerId, models)
      return models
    } catch (err) {
      logger.warn(`getModels failed for ${providerId}: ${(err as Error).message}`, { provider: providerId })
      return this.registry.byProvider(providerId)
    }
  }

  getModelInfo(providerId: string, modelId: string): ModelInfo | undefined {
    return this.registry.get(providerId, modelId)
  }

  async test(providerId: string): Promise<ValidationResult> {
    const provider = this.resolve(providerId)
    if (!provider) return { ok: false, message: 'Provider not configured or disabled.' }
    try {
      return await provider.validateConfiguration()
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
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
    case 'openai-compat':
      return process.env.CUBEX_OPENAI_COMPAT_API_KEY
    case 'ollama':
      return undefined // local, no secret
    default:
      void settings
      return undefined
  }
}
