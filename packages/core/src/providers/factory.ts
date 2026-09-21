import { NormalizedAIError } from '../types/errors'
import type { AIProvider, ProviderConfig } from '../types/provider'
import { OpenAIProvider } from './openai/OpenAIProvider'
import { AnthropicProvider } from './anthropic/AnthropicProvider'
import { OpenAICompatProvider } from './openai-compat/OpenAICompatProvider'
import { CustomProvider } from './custom/CustomProvider'
import { OllamaProvider } from './ollama/OllamaProvider'
import { MockAIProvider } from './mock/MockAIProvider'

/**
 * Instantiate the correct adapter for a provider config. This is the ONE place
 * that maps a `kind` to a concrete adapter — the rest of the app stays fully
 * provider-agnostic and only ever holds an `AIProvider`.
 *
 * llama.cpp's server and LM Studio both expose OpenAI-compatible HTTP APIs, so
 * they legitimately reuse the OpenAICompatProvider (tagged with their own kind).
 */
export function createProvider(cfg: ProviderConfig, secret?: string): AIProvider {
  switch (cfg.kind) {
    case 'openai':
      return new OpenAIProvider(cfg, secret)
    case 'anthropic':
      return new AnthropicProvider(cfg, secret)
    case 'openai-compat':
      return new OpenAICompatProvider(cfg, secret)
    case 'custom':
      return new CustomProvider(cfg, secret)
    case 'ollama':
      return new OllamaProvider(cfg, secret)
    case 'llamacpp':
      return new OpenAICompatProvider(cfg, secret, 'llamacpp')
    case 'lmstudio':
      return new OpenAICompatProvider(cfg, secret, 'lmstudio')
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
