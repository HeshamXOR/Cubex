import { describe, expect, it } from 'vitest'
import { describeIdentity, modelIdentity, modelVendor } from './modelIdentity'

describe('who made a model, from its id', () => {
  const cases: Array<[string, string | undefined]> = [
    ['claude-sonnet-5-5', 'Anthropic'],
    ['claude-opus-4-8', 'Anthropic'],
    ['anthropic/claude-3.5-sonnet', 'Anthropic'],
    ['gpt-6.1-sol', 'OpenAI'],
    ['o3-mini', 'OpenAI'],
    ['openai/gpt-oss-120b', 'OpenAI'],
    ['gemini-3-pro', 'Google'],
    ['google/gemma-3-27b-it', 'Google'],
    ['grok-4', 'xAI'],
    ['moonshotai/kimi-k3', 'Moonshot AI'],
    ['z-ai/glm-5.3-flash', 'Z.ai'],
    ['deepseek-ai/deepseek-r1', 'DeepSeek'],
    ['deepseek-r1-distill-llama-70b', 'DeepSeek'],
    ['qwen3-coder-480b', 'Alibaba Cloud (Qwen)'],
    ['meta/llama-3.3-70b-instruct', 'Meta'],
    ['mistralai/mistral-large', 'Mistral AI'],
    ['nvidia/llama-3.1-nemotron-70b', 'NVIDIA'],
    ['microsoft/phi-4', 'Microsoft'],
    ['command-r-plus', 'Cohere'],
    ['MiniMax-M2', 'MiniMax']
  ]
  it.each(cases)('%s is from %s', (id, vendor) => {
    expect(modelVendor(id)).toBe(vendor)
  })

  it('says nothing for an id it cannot place, rather than guessing', () => {
    expect(modelVendor('my-finetune-v2')).toBeUndefined()
    expect(modelVendor('llm')).toBeUndefined()
    expect(modelVendor('')).toBeUndefined()
  })
})

describe('what the model is told about itself', () => {
  it('uses the name the picker shows, the exact id and the maker', () => {
    const identity = modelIdentity('claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5' })
    expect(identity).toEqual({ name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', vendor: 'Anthropic' })
    expect(describeIdentity(identity)).toBe('Claude Sonnet 5.5 (model id claude-sonnet-5-5), made by Anthropic')
  })

  it('falls back to the id when the listing has no name of its own', () => {
    expect(modelIdentity('moonshotai/kimi-k3')).toEqual({ name: 'moonshotai/kimi-k3', vendor: 'Moonshot AI' })
    expect(modelIdentity('moonshotai/kimi-k3', { displayName: 'moonshotai/kimi-k3' })).toEqual({ name: 'moonshotai/kimi-k3', vendor: 'Moonshot AI' })
    expect(modelIdentity('x', { displayName: '   ' })).toEqual({ name: 'x' })
  })

  it('leaves the maker out for a model it cannot place', () => {
    expect(describeIdentity(modelIdentity('my-finetune-v2'))).toBe('my-finetune-v2')
  })
})
