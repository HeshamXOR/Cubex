import { NormalizedAIError } from '../types/errors'
import type { EffortModel } from './effort'
import type { AIProvider, ProviderConfig } from '../types/provider'
import { OpenAIProvider } from './openai/OpenAIProvider'
import { AnthropicProvider } from './anthropic/AnthropicProvider'
import { GeminiProvider } from './gemini/GeminiProvider'
import { OpenAICompatProvider } from './openai-compat/OpenAICompatProvider'
import { AzureOpenAIProvider } from './azure/AzureOpenAIProvider'
import { CustomProvider } from './custom/CustomProvider'
import { OllamaProvider } from './ollama/OllamaProvider'
import { MockAIProvider } from './mock/MockAIProvider'

export interface ProviderOptions {
  /**
   * What is known about a model beyond what its endpoint lists, such as the effort levels it takes. A compatible
   * endpoint reports nothing of the kind, so the app supplies it from the model catalog.
   */
  modelInfo?: (modelId: string) => EffortModel | undefined
}

/**
 * Instantiate the correct adapter for a provider config. This is the ONE place
 * that maps a `kind` to a concrete adapter — the rest of the app stays fully
 * provider-agnostic and only ever holds an `AIProvider`.
 *
 * llama.cpp's server and LM Studio both expose OpenAI-compatible HTTP APIs, so
 * they legitimately reuse the OpenAICompatProvider (tagged with their own kind).
 */
export function createProvider(cfg: ProviderConfig, secret?: string, options: ProviderOptions = {}): AIProvider {
  switch (cfg.kind) {
    case 'openai':
      return new OpenAIProvider(cfg, secret)
    case 'anthropic':
      return new AnthropicProvider(cfg, secret)
    case 'gemini':
      return new GeminiProvider(cfg, secret)
    case 'openai-compat':
      // Azure OpenAI is a mode of the compatible adapter: same wire format, routed by deployment.
      return cfg.apiMode === 'azure' ? new AzureOpenAIProvider(cfg, secret) : new OpenAICompatProvider(cfg, secret, 'openai-compat', options.modelInfo)
    case 'custom':
      return new CustomProvider(cfg, secret)
    case 'ollama':
      return new OllamaProvider(cfg, secret)
    case 'llamacpp':
      return new OpenAICompatProvider(cfg, secret, 'llamacpp', options.modelInfo)
    case 'lmstudio':
      return new OpenAICompatProvider(cfg, secret, 'lmstudio', options.modelInfo)
    case 'mock':
    case 'mock-local':
      return new MockAIProvider({ id: cfg.id, name: cfg.name })
    default:
      throw new NormalizedAIError({
        provider: cfg.id,
        category: 'INVALID_REQUEST',
        message: `Unknown provider kind: ${String(cfg.kind)}`,
        classification: 'permanent',
        retryable: false
      })
  }
}
