import { describe, expect, it } from 'vitest'
import { mapAnthUsage } from './translate'

describe('mapAnthUsage cache write lifetimes', () => {
  it('keeps the 1-hour share of the cache writes next to the total', () => {
    const usage = mapAnthUsage({
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
    })
    expect(usage).toMatchObject({ inputTokens: 410, cachedInputTokens: 100, cacheWriteInputTokens: 300, cacheWrite1hInputTokens: 200, outputTokens: 5 })
  })

  it('leaves the split out when the API does not report it or reports junk', () => {
    expect(mapAnthUsage({ input_tokens: 10, cache_creation_input_tokens: 300 })).not.toHaveProperty('cacheWrite1hInputTokens')
    expect(mapAnthUsage({ input_tokens: 10, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: -4 } })).not.toHaveProperty('cacheWrite1hInputTokens')
    expect(mapAnthUsage({ input_tokens: 10, cache_creation: null })).not.toHaveProperty('cacheWrite1hInputTokens')
  })

  it('carries the split through a later delta that does not repeat it', () => {
    const start = mapAnthUsage({ input_tokens: 10, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 300 } })
    const end = mapAnthUsage({ output_tokens: 42 }, start)
    expect(end).toMatchObject({ cacheWriteInputTokens: 300, cacheWrite1hInputTokens: 300, outputTokens: 42 })
  })
})
