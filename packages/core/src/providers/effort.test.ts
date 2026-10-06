import { describe, expect, it } from 'vitest'
import { defaultEffortFor, effortOptionsFor, infersReasoning, normalizeEffortFor, reasoningSupport } from './effort'
import { toChatCompletionsBody, toOpenAIEffort, toResponsesBody } from './openai/translate'
import { toAnthEffort, toAnthropicParams } from './anthropic/translate'
import type { ProviderKind } from '../types/provider'
import type { ReasoningEffort } from '../types/request'

describe('effortOptionsFor', () => {
  it('gives Anthropic the five-level scale including xhigh and max', () => {
    const vals = effortOptionsFor('anthropic', { id: 'claude-opus-4-8' }).map((o) => o.value)
    expect(vals).toEqual([undefined, 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('gives OpenAI minimal→max', () => {
    const vals = effortOptionsFor('openai', { id: 'gpt-5.6' }).map((o) => o.value)
    expect(vals).toEqual([undefined, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('gives Ollama no effort options (hidden in UI)', () => {
    expect(effortOptionsFor('ollama')).toEqual([])
  })
  it('defaults to medium where available, undefined where not', () => {
    expect(defaultEffortFor('anthropic', { id: 'claude-sonnet-4-6' })).toBe('medium')
    expect(defaultEffortFor('openai', { id: 'o3' })).toBe('medium')
    expect(defaultEffortFor('ollama')).toBeUndefined()
  })

  it.each(['openai-compat', 'lmstudio', 'llamacpp'] as const)('requires explicit reasoning support for %s', (kind) => {
    expect(effortOptionsFor(kind)).toEqual([])
    expect(effortOptionsFor(kind, { id: 'gpt-6-astra' })).toEqual([])
    expect(effortOptionsFor(kind, { id: 'fixture-model', supportsReasoning: false })).toEqual([])
    expect(effortOptionsFor(kind, { id: 'fixture-model', supportsReasoning: true }).map((option) => option.value))
      .toEqual([undefined, 'low', 'medium', 'high'])
  })

  it.each([
    ['openai', 'gpt-6-astra'], ['anthropic', 'claude-opus-4-8']
  ] as const)('lets explicit false override native %s model heuristics', (kind, id) => {
    expect(effortOptionsFor(kind, { id, supportsReasoning: false })).toEqual([])
    expect(defaultEffortFor(kind, { id, supportsReasoning: false })).toBeUndefined()
    expect(normalizeEffortFor(kind, 'max', { id, supportsReasoning: false })).toBeUndefined()
  })

  it('hides unsupported and unknown native models while metadata is unavailable', () => {
    expect(effortOptionsFor('openai')).toEqual([])
    expect(effortOptionsFor('openai', { id: 'gpt-4o' })).toEqual([])
    expect(effortOptionsFor('openai', { id: 'fixture-model' })).toEqual([])
    expect(effortOptionsFor('anthropic', { id: 'claude-haiku-4-5' })).toEqual([])
  })

  it('only offers values that pass through the native OpenAI adapter', () => {
    expect(effortOptionsFor('openai', { id: 'o3' }).map((option) => option.value))
      .toEqual([undefined, 'low', 'medium', 'high'])
    for (const id of ['o3', 'gpt-5', 'gpt-5.6', 'gpt-6-astra']) {
      for (const option of effortOptionsFor('openai', { id })) {
        expect(toOpenAIEffort(option.value, id)).toBe(option.value)
      }
    }
  })

  it('labels Default and all visible options, and omits Default on each wire format', () => {
    const model = { id: 'gpt-6-astra' }
    const choices = effortOptionsFor('openai', model)
    expect(choices[0]).toMatchObject({ value: undefined, label: 'Default' })
    expect(choices.every((option) => option.label.trim().length > 0 && option.hint.trim().length > 0)).toBe(true)
    const request = { model: model.id, messages: [], params: { reasoningEffort: normalizeEffortFor('openai', undefined, model) } }
    expect(toChatCompletionsBody(request)).not.toHaveProperty('reasoning_effort')
    expect(toResponsesBody(request, true)).not.toHaveProperty('reasoning')
    expect(toAnthropicParams({ ...request, model: 'claude-opus-4-8' }, true)).not.toHaveProperty('output_config')
    expect(toAnthropicParams({ ...request, model: 'claude-opus-4-8' }, true)).not.toHaveProperty('thinking')
  })

  it.each(['ollama', 'custom', 'mock', 'mock-local'] satisfies ProviderKind[])('hides controls without an effort adapter for %s', (kind) => {
    expect(effortOptionsFor(kind, { id: 'reasoning-model', supportsReasoning: true })).toEqual([])
  })

  it('clamps saved native and generic efforts to supported values', () => {
    expect(normalizeEffortFor('openai', 'max', { id: 'o3' })).toBe('high')
    expect(normalizeEffortFor('openai', 'minimal', { id: 'gpt-6-astra' })).toBe('low')
    expect(normalizeEffortFor('anthropic', 'minimal', { id: 'claude-opus-4-8' })).toBe('low')
    expect(normalizeEffortFor('openai-compat', 'max', { id: 'fixture-model', supportsReasoning: true })).toBe('high')
    expect(normalizeEffortFor('openai-compat', 'high', { id: 'fixture-model' })).toBeUndefined()
  })
})

describe('toOpenAIEffort mapping', () => {
  it('passes xhigh/max through for GPT-6 and GPT-5.6', () => {
    expect(toOpenAIEffort('xhigh', 'gpt-6-astra')).toBe('xhigh')
    expect(toOpenAIEffort('max', 'gpt-5.6')).toBe('max')
  })
  it('clamps xhigh/max to high on older reasoning models', () => {
    expect(toOpenAIEffort('xhigh', 'o3')).toBe('high')
    expect(toOpenAIEffort('max', 'gpt-5')).toBe('high')
  })
  it('allows minimal only on the gpt-5 family', () => {
    expect(toOpenAIEffort('minimal', 'gpt-5')).toBe('minimal')
    expect(toOpenAIEffort('minimal', 'o3')).toBe('low')
  })
  it('passes low/medium/high through', () => {
    expect(toOpenAIEffort('medium', 'o3')).toBe('medium')
  })
  it('returns undefined for no effort', () => {
    expect(toOpenAIEffort(undefined, 'gpt-6-astra')).toBeUndefined()
  })
})

describe('toAnthEffort mapping', () => {
  it('maps minimal to low and keeps the rest', () => {
    expect(toAnthEffort('minimal')).toBe('low')
    expect(toAnthEffort('xhigh')).toBe('xhigh')
    expect(toAnthEffort('max')).toBe('max')
  })
  it('returns undefined for no effort', () => {
    expect(toAnthEffort(undefined)).toBeUndefined()
  })
})

describe('reasoning models behind a generic OpenAI-compatible endpoint', () => {
  // A /models listing on a compatible endpoint reports nothing about reasoning,
  // so the default capability set leaves supportsReasoning false. Treating that
  // as "unsupported" hid the effort control for every such provider.
  const compat = (id: string) => effortOptionsFor('openai-compat', { id, supportsReasoning: false })

  it('offers effort for a reasoning model whose endpoint reports no capability', () => {
    for (const id of [
      'deepseek-ai/deepseek-r1',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'qwen/qwen3-235b-a22b',
      'openai/gpt-oss-120b',
      'moonshotai/kimi-k2-thinking',
      'mistralai/magistral-small-2506',
      'zai-org/glm-4.6'
    ]) {
      expect(compat(id).length, id).toBeGreaterThan(0)
    }
  })

  it('still hides effort for a model that does not reason', () => {
    for (const id of ['meta/llama-3.1-8b-instruct', 'mistralai/mistral-7b-instruct-v0.3']) {
      expect(compat(id), id).toEqual([])
    }
  })

  it('keeps a declared capability authoritative', () => {
    expect(effortOptionsFor('openai-compat', { id: 'house-model-v2', supportsReasoning: true }).length).toBeGreaterThan(0)
  })

  it('lets a compat reasoning effort survive normalization so the adapter sends it', () => {
    expect(normalizeEffortFor('openai-compat', 'high', { id: 'deepseek-ai/deepseek-r1', supportsReasoning: false })).toBe('high')
  })

  it('does not treat an unrelated id containing r1 as a reasoning model', () => {
    expect(infersReasoning('gemma-2-27b-it')).toBe(false)
    expect(infersReasoning('mixtral-8x7b-instruct-v0.1')).toBe(false)
  })

  it('leaves a native provider that truly reports no reasoning hidden', () => {
    expect(effortOptionsFor('anthropic', { id: 'claude-opus-5-5', supportsReasoning: false })).toEqual([])
  })
})

describe('effort levels a model reports itself', () => {
  // Kimi K3 on NVIDIA takes low, high or max, and rejects anything else. The endpoint lists no capabilities, so the
  // model catalog is where these come from.
  const k3 = { id: 'moonshotai/kimi-k3', supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'] satisfies ReasoningEffort[] }

  it('offers exactly the levels the model reports, behind the default', () => {
    expect(effortOptionsFor('openai-compat', k3).map((option) => option.value)).toEqual([undefined, 'low', 'high', 'max'])
    expect(effortOptionsFor('openai-compat', k3).map((option) => option.label)).toEqual(['Default', 'Low', 'High', 'Max'])
  })

  it('lists the levels lowest first whatever order they were reported in', () => {
    const values = effortOptionsFor('openai-compat', { ...k3, reasoningEfforts: ['max', 'low', 'medium'] }).map((option) => option.value)
    expect(values).toEqual([undefined, 'low', 'medium', 'max'])
  })

  it('hides the control for a model that reasons but takes no effort setting', () => {
    expect(effortOptionsFor('openai-compat', { ...k3, reasoningEfforts: [] })).toEqual([])
    // The report wins over a recognised id.
    expect(effortOptionsFor('openai-compat', { id: 'deepseek-ai/deepseek-r1', supportsReasoning: true, reasoningEfforts: [] })).toEqual([])
  })

  it('applies to the generic kinds only', () => {
    expect(effortOptionsFor('lmstudio', k3).map((option) => option.value)).toEqual([undefined, 'low', 'high', 'max'])
    expect(effortOptionsFor('anthropic', { id: 'claude-opus-5-5', reasoningEfforts: ['low'] }).length).toBe(6)
  })

  it('keeps a reported level through normalization, so the adapter sends it', () => {
    expect(normalizeEffortFor('openai-compat', 'max', k3)).toBe('max')
    expect(normalizeEffortFor('openai-compat', 'low', k3)).toBe('low')
  })

  it('moves a level the model does not offer to the nearest one it does, the lower on a tie', () => {
    expect(normalizeEffortFor('openai-compat', 'medium', k3)).toBe('low')
    expect(normalizeEffortFor('openai-compat', 'xhigh', k3)).toBe('high')
    expect(normalizeEffortFor('openai-compat', 'minimal', k3)).toBe('low')
    expect(normalizeEffortFor('openai-compat', undefined, k3)).toBeUndefined()
  })

  it('recognises Kimi K2.5 and later by id when no catalog has been read yet', () => {
    for (const id of ['moonshotai/kimi-k3', 'moonshotai/kimi-k2.6', 'kimi-k2.5']) expect(infersReasoning(id), id).toBe(true)
    expect(infersReasoning('moonshotai/kimi-k2-instruct')).toBe(false)
  })
})

describe('reasoningSupport', () => {
  it('trusts a reported flag', () => {
    expect(reasoningSupport('anthropic', { id: 'claude-opus-5-5', supportsReasoning: true })).toBe('yes')
    expect(reasoningSupport('anthropic', { id: 'claude-haiku-4-5', supportsReasoning: false })).toBe('no')
  })

  it('recognises a reasoning model behind a compatible endpoint even though the listing said false', () => {
    expect(reasoningSupport('openai-compat', { id: 'deepseek-ai/deepseek-r1', supportsReasoning: false })).toBe('yes')
  })

  it('says unreported, not no, when a compatible endpoint is silent and the id gives nothing away', () => {
    expect(reasoningSupport('openai-compat', { id: 'meta/llama-3.1-8b-instruct', supportsReasoning: false })).toBe('unreported')
    expect(reasoningSupport('lmstudio', { id: 'local-model', supportsReasoning: false })).toBe('unreported')
  })

  it('is a plain no for a native provider and for no provider at all', () => {
    expect(reasoningSupport('ollama', { id: 'llama3', supportsReasoning: false })).toBe('no')
    expect(reasoningSupport(undefined, { id: 'x', supportsReasoning: false })).toBe('no')
  })
})
