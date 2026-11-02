import { describe, expect, it } from 'vitest'
import { describeIdentity, modelIdentity, modelVendor } from './modelIdentity'

describe('who made a model, from its id', () => {
  const cases: Array<[string, string | undefined]> = [
    ['claude-sonnet-5-5', 'Anthropic'],
    ['gpt-6.1-sol', 'OpenAI'],
    ['gemini-3-pro', 'Google'],
    ['moonshotai/kimi-k3', 'Moonshot AI'],
    ['deepseek-ai/deepseek-r1', 'DeepSeek'],
    ['qwen3-coder-480b', 'Alibaba Cloud (Qwen)'],
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
})
