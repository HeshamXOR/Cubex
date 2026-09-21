import type { Capability } from '../types/capabilities'
import type { ModelInfo } from '../types/model'

/**
 * In-memory model registry. Models can be registered dynamically (from a
 * provider's getModels()) or added manually. Capabilities are never assumed —
 * they come from the ModelInfo the provider/user supplies.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>()

  private key(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`
  }

  register(model: ModelInfo): void {
    this.models.set(this.key(model.providerId, model.id), model)
  }

  registerMany(models: ModelInfo[]): void {
    for (const m of models) this.register(m)
  }

  /** Replace all models for a provider (used after a fresh getModels()). */
  replaceProvider(providerId: string, models: ModelInfo[]): void {
    for (const k of [...this.models.keys()]) {
      if (k.startsWith(`${providerId}::`)) this.models.delete(k)
    }
    this.registerMany(models)
  }

  get(providerId: string, modelId: string): ModelInfo | undefined {
    return this.models.get(this.key(providerId, modelId))
  }

  all(): ModelInfo[] {
    return [...this.models.values()]
  }

  byProvider(providerId: string): ModelInfo[] {
    return this.all().filter((m) => m.providerId === providerId)
  }

  withCapability(cap: Capability): ModelInfo[] {
    return this.all().filter((m) => m.capabilities.includes(cap))
  }

  supports(providerId: string, modelId: string, cap: Capability): boolean {
    return this.get(providerId, modelId)?.capabilities.includes(cap) ?? false
  }

  clear(): void {
    this.models.clear()
  }
}
