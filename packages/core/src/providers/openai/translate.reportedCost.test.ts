import { describe, expect, it } from 'vitest'
import { mapChatUsage } from './translate'

describe('mapChatUsage provider-reported cost', () => {
  it('takes the cost OpenRouter returns, with its cache read and write counts', () => {
    const usage = mapChatUsage({
      prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.00123,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 100 }
    })
    expect(usage).toEqual({
      inputTokens: 194, outputTokens: 2, totalTokens: 196, cachedInputTokens: 40, cacheWriteInputTokens: 100, reportedCostUsd: 0.00123
    })
  })

  it('adds the upstream charge for bring-your-own-key requests, where cost is only OpenRouter\'s fee', () => {
    const byok = mapChatUsage({ prompt_tokens: 1, cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: 19 } })
    expect(byok?.reportedCostUsd).toBeCloseTo(19.95, 9)
    // Not BYOK: the upstream figure is informational and already inside cost.
    expect(mapChatUsage({ prompt_tokens: 1, cost: 0.95, is_byok: false, cost_details: { upstream_inference_cost: 19 } })?.reportedCostUsd).toBe(0.95)
    expect(mapChatUsage({ prompt_tokens: 1, cost: 0.95, cost_details: { upstream_inference_cost: 19 } })?.reportedCostUsd).toBe(0.95)
    expect(mapChatUsage({ prompt_tokens: 1, cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: null } })?.reportedCostUsd).toBe(0.95)
  })

  it('keeps a reported cost of zero (free models) and ignores anything that is not a sane amount', () => {
    expect(mapChatUsage({ prompt_tokens: 1, cost: 0 })?.reportedCostUsd).toBe(0)
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, '0.5' as unknown as number]) {
      expect(mapChatUsage({ prompt_tokens: 1, cost })).not.toHaveProperty('reportedCostUsd')
    }
    expect(mapChatUsage({ prompt_tokens: 1, prompt_tokens_details: { cache_write_tokens: -3 } })).not.toHaveProperty('cacheWriteInputTokens')
  })

  it('leaves plain OpenAI usage exactly as before', () => {
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } }))
      .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 4 })
  })

  it('counts thinking a provider reports only in the total as output', () => {
    expect(mapChatUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 640, completion_tokens_details: { reasoning_tokens: 600 } }))
      .toEqual({ inputTokens: 100, outputTokens: 540, totalTokens: 640, reasoningTokens: 600 })
    // Where completion already includes it, nothing is added a second time.
    expect(mapChatUsage({ prompt_tokens: 100, completion_tokens: 640, total_tokens: 740, completion_tokens_details: { reasoning_tokens: 600 } }))
      .toEqual({ inputTokens: 100, outputTokens: 640, totalTokens: 740, reasoningTokens: 600 })
    // A total that is short of its parts is not trusted.
    expect(mapChatUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 90 })?.outputTokens).toBe(40)
    expect(mapChatUsage({ prompt_tokens: 100, completion_tokens: 40 })?.outputTokens).toBe(40)
  })
})
