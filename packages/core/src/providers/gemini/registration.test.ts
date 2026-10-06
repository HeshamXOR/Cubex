import { describe, expect, it } from 'vitest'
import { defaultEffortFor, effortOptionsFor, normalizeEffortFor, requestWithSupportedEffort } from '../effort'
import { createProvider } from '../factory'
import * as providers from '../index'
import type { ProviderConfig } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import { GeminiProvider } from './GeminiProvider'

const cfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'gem',
  kind: 'gemini',
  name: 'Gemini',
  accessType: 'api',
  auth: { type: 'api_key' },
  enabled: true,
  ...overrides
})

describe('kind gemini: factory and exports', () => {
  it('builds a GeminiProvider', () => {
    const provider = createProvider(cfg(), 'key')
    expect(provider).toBeInstanceOf(GeminiProvider)
    expect(provider.kind).toBe('gemini')
  })

  it('is exported from the providers barrel, with the pieces the app builds on', () => {
    expect(providers.GeminiProvider).toBe(GeminiProvider)
    expect(typeof providers.sanitizeGeminiSchema).toBe('function')
    expect(typeof providers.toGeminiRequest).toBe('function')
    expect(typeof providers.normalizeGeminiError).toBe('function')
  })
})

describe('kind gemini: reasoning effort options', () => {
  const values = (id: string, supportsReasoning?: boolean): Array<string | undefined> =>
    effortOptionsFor('gemini', { id, ...(supportsReasoning !== undefined ? { supportsReasoning } : {}) }).map((o) => o.value)

  it('offers Gemini 3 only the levels that model accepts, led by the default', () => {
    expect(values('gemini-3-pro-preview')).toEqual([undefined, 'low', 'high'])
    expect(values('gemini-3.1-pro-preview')).toEqual([undefined, 'low', 'medium', 'high'])
    expect(values('gemini-3-flash-preview')).toEqual([undefined, 'minimal', 'low', 'medium', 'high'])
    expect(values('gemini-3.8-flash')).toEqual([undefined, 'low', 'medium', 'high'])
  })

  it('offers Gemini 2.5 token budgets, with an off switch only where thinking can be off', () => {
    const flash = effortOptionsFor('gemini', { id: 'gemini-2.5-flash' })
    expect(flash.map((o) => o.value)).toEqual([undefined, 'minimal', 'low', 'medium', 'high'])
    expect(flash.find((o) => o.value === 'minimal')).toMatchObject({ label: 'Off' })
    const pro = effortOptionsFor('gemini', { id: 'gemini-2.5-pro' })
    expect(pro.map((o) => o.value)).toEqual([undefined, 'minimal', 'low', 'medium', 'high', 'max'])
    expect(pro.find((o) => o.value === 'minimal')).toMatchObject({ label: 'Minimum' })
  })

  it('gives every option a label and a hint', () => {
    for (const option of effortOptionsFor('gemini', { id: 'gemini-2.5-pro' })) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.hint.length).toBeGreaterThan(0)
    }
  })

  it('hides the selector where there is nothing to choose', () => {
    expect(values('gemini-2.0-flash')).toEqual([])
    expect(values('gemini-2.5-pro', false)).toEqual([])
    expect(values('gemini-flash-latest')).toEqual([])
    expect(values('some-tuned-model', true)).toEqual([])
    expect(effortOptionsFor('gemini', undefined)).toEqual([])
  })

  it('defaults to no explicit effort: the model default differs per model', () => {
    expect(defaultEffortFor('gemini', { id: 'gemini-2.5-flash' })).toBeUndefined()
    expect(defaultEffortFor('gemini', { id: 'gemini-3-flash-preview' })).toBeUndefined()
  })

  it('normalizes a stale or foreign effort to one the model accepts, or drops it', () => {
    expect(normalizeEffortFor('gemini', 'xhigh', { id: 'gemini-3.1-pro-preview' })).toBe('high')
    expect(normalizeEffortFor('gemini', 'minimal', { id: 'gemini-3-pro-preview' })).toBe('low')
    expect(normalizeEffortFor('gemini', 'max', { id: 'gemini-2.5-flash' })).toBe('high')
    expect(normalizeEffortFor('gemini', 'max', { id: 'gemini-2.5-pro' })).toBe('max')
    expect(normalizeEffortFor('gemini', 'high', { id: 'gemini-2.0-flash' })).toBeUndefined()
  })

  it('strips an effort from a request to a model that cannot take one, without mutating the original', () => {
    const request: AIRequest = { model: 'gemini-2.0-flash', messages: [], params: { reasoningEffort: 'high', temperature: 0.2 } }
    const out = requestWithSupportedEffort('gemini', request)
    expect(out.params).toEqual({ temperature: 0.2 })
    expect(request.params?.reasoningEffort).toBe('high')
  })
})
