import { describe, expect, it } from 'vitest'
import { mapAnthUsage } from '@core/providers/anthropic/translate'
import { mapGeminiUsage } from '@core/providers/gemini/stream'
import { mapOllamaUsage } from '@core/providers/ollama/OllamaProvider'
import { mapChatUsage, mapResponsesUsage } from '@core/providers/openai/translate'
import type { Usage } from '@core/types'
import { ContextAnchorStore } from './contextAnchor'

/** What the meter anchors on after a response whose usage the adapter mapped to `usage`. */
function anchored(usage: Usage | undefined): number | undefined {
  const store = new ContextAnchorStore()
  store.recordUsage('task', usage, 10_000)
  return store.get('task')?.inputTokens
}

describe('the anchor is the whole prompt, whatever the provider reports', () => {
  it('Anthropic reports uncached, cache-read and cache-write input apart, and all three are in the prompt', () => {
    const usage = mapAnthUsage({ input_tokens: 25, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 500, output_tokens: 80 })
    expect(anchored(usage)).toBe(9_525)
  })

  it('Anthropic: input arrives in message_start and output in message_delta, and the delta does not wipe the input', () => {
    const start = mapAnthUsage({ input_tokens: 25, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 1 })
    const delta = mapAnthUsage({ output_tokens: 420 }, start)
    expect(delta).toMatchObject({ inputTokens: 9_025, outputTokens: 420 })
    expect(anchored(delta)).toBe(9_025)
  })

  it('OpenAI Chat Completions: prompt_tokens already includes the cached tokens, so they are not added again', () => {
    const usage = mapChatUsage({ prompt_tokens: 10_000, completion_tokens: 120, total_tokens: 10_120, prompt_tokens_details: { cached_tokens: 8_000 } })
    expect(usage).toMatchObject({ inputTokens: 10_000, cachedInputTokens: 8_000 })
    expect(anchored(usage)).toBe(10_000)
  })

  it('a compatible host that reports cache reads (the glm records in the task database) is also inclusive', () => {
    const usage = mapChatUsage({ prompt_tokens: 11_589, completion_tokens: 91, total_tokens: 11_680, prompt_tokens_details: { cached_tokens: 10_240 } })
    expect(anchored(usage)).toBe(11_589)
  })

  it('a gateway that fronts Anthropic and reports only the uncached remainder as prompt_tokens is summed', () => {
    const usage = mapChatUsage({ prompt_tokens: 25, completion_tokens: 80, total_tokens: 105, prompt_tokens_details: { cached_tokens: 9_000, cache_write_tokens: 500 } })
    expect(usage).toMatchObject({ inputTokens: 9_525, cachedInputTokens: 9_000, cacheWriteInputTokens: 500, outputTokens: 80, totalTokens: 9_605 })
    expect(anchored(usage)).toBe(9_525)
  })

  it('OpenRouter-style cache writes inside prompt_tokens are not added a second time', () => {
    const usage = mapChatUsage({ prompt_tokens: 10_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 3_000 } })
    expect(anchored(usage)).toBe(10_000)
  })

  it('OpenAI Responses: input_tokens includes input_tokens_details.cached_tokens', () => {
    const usage = mapResponsesUsage({ input_tokens: 10_000, output_tokens: 700, total_tokens: 10_700, input_tokens_details: { cached_tokens: 8_000 }, output_tokens_details: { reasoning_tokens: 600 } })
    expect(usage).toMatchObject({ inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 700, reasoningTokens: 600 })
    expect(anchored(usage)).toBe(10_000)
  })

  it('Gemini: promptTokenCount includes the cached content, and thoughts are output, not input', () => {
    const usage = mapGeminiUsage({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 100, thoughtsTokenCount: 900, totalTokenCount: 11_000 })
    expect(usage).toMatchObject({ inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000, reasoningTokens: 900 })
    expect(anchored(usage)).toBe(10_000)
  })

  it('Ollama: prompt_eval_count is the prompt', () => {
    expect(anchored(mapOllamaUsage({ done: true, prompt_eval_count: 4_200, eval_count: 310 } as Parameters<typeof mapOllamaUsage>[0]))).toBe(4_200)
  })

  it('a provider that reports no input leaves the estimate in charge', () => {
    expect(anchored(mapChatUsage({ completion_tokens: 12 }))).toBeUndefined()
    expect(anchored(undefined)).toBeUndefined()
  })
})
