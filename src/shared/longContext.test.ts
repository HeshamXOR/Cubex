import { describe, expect, it } from 'vitest'
import type { Capability, ModelInfo, ProviderConfig } from '@core/types'
import { declaredLongContextModels, declaredModelInfo, declaresLongContext, markLongContext, markLongContextModels, normalizeLongContextModels } from './longContext'

const cfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p', kind: 'anthropic', name: 'P', accessType: 'api', auth: { type: 'api_key' }, enabled: true, ...overrides
})

const listed = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id, providerId: 'p', displayName: id, location: 'cloud', capabilities: ['text'] as Capability[],
  modalities: { input: ['text'], output: ['text'] }, supportsTools: true, supportsStructuredOutput: true, supportsReasoning: false, ...overrides
})

describe('the models a provider declares as offering 1M', () => {
  it('tidies what is stored: trimmed, without duplicates, bounded', () => {
    expect(declaredLongContextModels(cfg({ longContextModels: [' a ', 'A', 'b', ''] }))).toEqual(['a', 'b'])
    expect(declaredLongContextModels(cfg({ longContextModels: Array.from({ length: 60 }, (_, i) => `m${i}`) }))).toHaveLength(50)
    expect(declaredLongContextModels(cfg())).toEqual([])
  })

  it('matches a model however the person spelled it', () => {
    const provider = cfg({ longContextModels: ['claude-sonnet-4-5-20250929'] })
    expect(declaresLongContext(provider, 'Claude-Sonnet-4-5-20250929')).toBe(true)
    expect(declaresLongContext(provider, 'claude-opus-4-8')).toBe(false)
  })

  it('keeps nothing when every entry is blank', () => {
    expect(normalizeLongContextModels(['  ', ''])).toBeUndefined()
    expect(normalizeLongContextModels('not a list')).toBeUndefined()
    expect(normalizeLongContextModels([' x '])).toEqual(['x'])
  })
})

describe('a declared model, in a provider list', () => {
  const provider = cfg({ longContextModels: ['relay-sonnet-1m'] })

  it('gets the 1M option when its listing leaves out the bigger window', () => {
    const model = markLongContext(provider, listed('relay-sonnet-1m', { contextWindow: 200_000 }))
    expect(model.longContextBeta).toBe(true)
  })

  it('gets it too when the listing says nothing about a window', () => {
    expect(markLongContext(provider, listed('relay-sonnet-1m')).longContextBeta).toBe(true)
  })

  it('leaves a model already sized at the gated window alone', () => {
    const native = listed('relay-sonnet-1m', { contextWindow: 1_000_000 })
    expect(markLongContext(provider, native)).toBe(native)
  })

  it('leaves models nobody declared alone, and skips the whole pass when nothing is declared', () => {
    const other = listed('some-other-model', { contextWindow: 128_000 })
    expect(markLongContext(provider, other)).toBe(other)
    const none = [other]
    expect(markLongContextModels(cfg(), none)).toBe(none)
  })
})

describe('a declared model the provider never listed', () => {
  it('is offered with the catalog description it has', () => {
    const model = declaredModelInfo(cfg({ longContextModels: ['claude-sonnet-4-5-20250929'] }), 'claude-sonnet-4-5-20250929', {
      displayName: 'Claude Sonnet 4.5', family: 'claude-sonnet-4', contextWindow: 200_000, maxOutputTokens: 64_000,
      supportsTools: true, supportsReasoning: true, reasoningEfforts: ['low', 'max'], capabilities: ['text', 'tools']
    })
    expect(model).toMatchObject({
      id: 'claude-sonnet-4-5-20250929', providerId: 'p', displayName: 'Claude Sonnet 4.5', contextWindow: 200_000,
      maxOutputTokens: 64_000, supportsReasoning: true, reasoningEfforts: ['low', 'max'], longContextBeta: true
    })
  })

  it('is offered with no window at all when nothing describes it, rather than a made-up one', () => {
    const model = declaredModelInfo(cfg({ longContextModels: ['relay-1m'] }), 'relay-1m', undefined)
    expect(model).toMatchObject({ id: 'relay-1m', displayName: 'relay-1m', longContextBeta: true })
    expect(model?.contextWindow).toBeUndefined()
  })

  it('is not offered for a model nobody declared', () => {
    expect(declaredModelInfo(cfg(), 'relay-1m', undefined)).toBeUndefined()
  })
})
