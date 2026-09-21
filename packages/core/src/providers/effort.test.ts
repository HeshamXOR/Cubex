import { describe, expect, it } from 'vitest'
import { defaultEffortFor, effortOptionsFor } from './effort'
import { toOpenAIEffort } from './openai/translate'
import { toAnthEffort } from './anthropic/translate'

describe('effortOptionsFor', () => {
  it('gives Anthropic the five-level scale including xhigh and max', () => {
    const vals = effortOptionsFor('anthropic').map((o) => o.value)
    expect(vals).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('gives OpenAI minimal→max', () => {
    const vals = effortOptionsFor('openai').map((o) => o.value)
    expect(vals).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('gives Ollama no effort options (hidden in UI)', () => {
    expect(effortOptionsFor('ollama')).toEqual([])
  })
  it('defaults to medium where available, undefined where not', () => {
    expect(defaultEffortFor('anthropic')).toBe('medium')
    expect(defaultEffortFor('openai')).toBe('medium')
    expect(defaultEffortFor('ollama')).toBeUndefined()
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
