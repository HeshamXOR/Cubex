import { describe, expect, it } from 'vitest'
import { AUTO_OUTPUT_TOKENS, ESCALATED_OUTPUT_TOKENS, escalatedOutputLimit, outputLimitFromError, resolveOutputLimit } from './outputLimit'

describe('the answer limit a request is sent with', () => {
  it('uses the automatic size when nothing was chosen, and whatever number was chosen otherwise', () => {
    expect(resolveOutputLimit(undefined, undefined)).toBe(AUTO_OUTPUT_TOKENS)
    expect(resolveOutputLimit(0, undefined)).toBe(AUTO_OUTPUT_TOKENS)
    expect(resolveOutputLimit(-5, undefined)).toBe(AUTO_OUTPUT_TOKENS)
    expect(resolveOutputLimit(Number.NaN, undefined)).toBe(AUTO_OUTPUT_TOKENS)
    expect(resolveOutputLimit(12_000, undefined)).toBe(12_000)
  })

  it('never asks a model for more than it can produce', () => {
    expect(resolveOutputLimit(undefined, 8_192)).toBe(8_192)
    expect(resolveOutputLimit(100_000, 64_000)).toBe(64_000)
    expect(resolveOutputLimit(2_048, 64_000)).toBe(2_048)
    expect(resolveOutputLimit(undefined, 131_072)).toBe(AUTO_OUTPUT_TOKENS)
  })

  it('offers a higher limit only while the model has room for one', () => {
    expect(escalatedOutputLimit(AUTO_OUTPUT_TOKENS, 131_072)).toBe(ESCALATED_OUTPUT_TOKENS)
    expect(escalatedOutputLimit(AUTO_OUTPUT_TOKENS, 40_000)).toBe(40_000)
    expect(escalatedOutputLimit(AUTO_OUTPUT_TOKENS, undefined)).toBe(ESCALATED_OUTPUT_TOKENS)
    expect(escalatedOutputLimit(ESCALATED_OUTPUT_TOKENS, 131_072)).toBeUndefined()
    expect(escalatedOutputLimit(8_192, 8_192)).toBeUndefined()
  })
})

describe('the limit a provider names when it refuses ours', () => {
  const cases: Array<[string, string, number | undefined]> = [
    ['Anthropic', 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022', 8_192],
    ['OpenAI chat', 'max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.', 16_384],
    ['OpenAI newer parameter', 'max_completion_tokens is too large: 200000. This model supports at most 100000 completion tokens, whereas you provided 200000.', 100_000],
    ['vLLM context window', "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 8192 tokens and your request has 5000 input tokens (32000 > 8192 - 5000).", 3_192],
    ['validation error', '{"detail":[{"type":"less_than_equal","loc":["body","max_tokens"],"msg":"Input should be less than or equal to 4096","input":32000}]}', 4_096],
    ['older validation wording', 'max_tokens: ensure this value is less than or equal to 4096', 4_096],
    ['thousands separators', 'max_tokens must be at most 16,384 for this model', 16_384]
  ]
  it.each(cases)('reads %s', (_name, message, expected) => {
    expect(outputLimitFromError(message)).toBe(expected)
  })

  it('says nothing when the message is about something else or names no usable number', () => {
    expect(outputLimitFromError('Rate limit exceeded: 4096 tokens per minute')).toBeUndefined()
    expect(outputLimitFromError('Your max_tokens value was rejected.')).toBeUndefined()
    expect(outputLimitFromError('max_tokens must be less than or equal to 8')).toBeUndefined()
    expect(outputLimitFromError('invalid api key')).toBeUndefined()
  })
})
