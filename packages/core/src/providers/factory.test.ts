import { describe, expect, it } from 'vitest'
import { createProvider } from './factory'
import { OpenAICompatProvider } from './openai-compat/OpenAICompatProvider'
import type { ProviderConfig } from '../types/provider'

function cfg(kind: ProviderConfig['kind']): ProviderConfig {
  return {
    id: `p-${kind}`,
    kind,
    name: kind,
    accessType: kind === 'ollama' ? 'local' : 'api',
    baseUrl: 'https://x.test/v1',
    auth: { type: 'none' },
    enabled: true
  }
}

describe('createProvider', () => {
  it('builds each provider kind', () => {
    expect(createProvider(cfg('openai'), 'k').kind).toBe('openai')
    expect(createProvider(cfg('anthropic'), 'k').kind).toBe('anthropic')
    expect(createProvider(cfg('openai-compat'), 'k').kind).toBe('openai-compat')
    expect(createProvider(cfg('custom')).kind).toBe('custom')
    expect(createProvider(cfg('ollama')).kind).toBe('ollama')
    expect(createProvider(cfg('mock')).kind).toBe('mock')
  })

  it('maps llamacpp and lmstudio to the OpenAI-compatible adapter', () => {
    const llama = createProvider(cfg('llamacpp'), 'k')
    const lm = createProvider(cfg('lmstudio'), 'k')
    expect(llama).toBeInstanceOf(OpenAICompatProvider)
    expect(lm).toBeInstanceOf(OpenAICompatProvider)
    expect(llama.kind).toBe('llamacpp')
    expect(lm.kind).toBe('lmstudio')
  })

  it('throws a clear error for an unknown kind', () => {
    expect(() => createProvider(cfg('bogus' as ProviderConfig['kind']))).toThrow(/Unknown provider kind/)
  })
})
