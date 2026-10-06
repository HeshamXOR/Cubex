import { describe, expect, it } from 'vitest'
import { NormalizedAIError, type ErrorCategory } from '../types/errors'
import { normalizeGeminiError } from '../providers/gemini/errors'
import { classify, normalizeHttpError } from './normalize'
import { isContextOverflow } from './overflow'

const http = (provider: string, status: number, body: unknown): NormalizedAIError => normalizeHttpError({ provider, status, body })
const direct = (provider: string, category: ErrorCategory, message: string, statusCode?: number): NormalizedAIError =>
  new NormalizedAIError({ provider, category, message, classification: classify(category), retryable: false, ...(statusCode ? { statusCode } : {}) })

interface Case { name: string; error: NormalizedAIError }

/** Bodies as the providers send them, passed through the same normalizer the adapters use. */
const OVERFLOWS: Case[] = [
  { name: 'Anthropic prompt is too long', error: http('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 213456 tokens > 200000 maximum' } }) },
  { name: 'Anthropic input plus max_tokens', error: http('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again' } }) },
  { name: 'Anthropic request too large (bytes)', error: http('anthropic', 413, { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' } }) },
  { name: 'Bedrock input too long', error: direct('bedrock', 'INVALID_REQUEST', 'ValidationException: Input is too long for requested model.', 400) },
  { name: 'Vertex Claude prompt too long', error: http('vertex', 400, { error: { code: 400, message: 'prompt is too long: 201000 tokens > 200000 maximum', status: 'INVALID_ARGUMENT' } }) },
  { name: 'OpenAI context_length_exceeded', error: http('openai', 400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130518 tokens. Please reduce the length of the messages.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }) },
  { name: 'OpenAI Responses input exceeds window', error: http('openai', 400, { error: { message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } }) },
  { name: 'OpenAI without a code', error: http('openai', 400, { error: { message: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens (8000 in your prompt; 1000 for the completion). Please reduce your prompt; or completion length.", type: 'invalid_request_error', param: 'messages', code: null } }) },
  { name: 'Azure context_length_exceeded', error: http('azure', 400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens (149000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }) },
  { name: 'Azure input tokens exceed the configured limit', error: http('azure', 400, { error: { message: 'Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 301213 tokens. Please reduce the length of the messages.', type: 'invalid_request_error', code: 'context_length_exceeded' } }) },
  { name: 'Azure without a code', error: http('azure', 400, { error: { message: 'Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 301213 tokens. Please reduce the length of the messages.' } }) },
  { name: 'OpenRouter endpoint wording', error: http('openrouter', 400, { error: { message: `This endpoint's maximum context length is 131072 tokens. However, you requested about 148000 tokens (130000 of text input, 18000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.`, code: 400 } }) },
  { name: 'OpenRouter wrapped upstream error', error: http('openrouter', 400, { error: { message: 'Provider returned error', code: 400, metadata: { raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 213456 tokens > 200000 maximum' } }), provider_name: 'Anthropic' } } }) },
  { name: 'OpenRouter wrapped plain-text upstream error', error: http('openrouter', 400, { error: { message: 'Provider returned error', code: 400, metadata: { raw: 'Input is too long for requested model', provider_name: 'Amazon Bedrock' } } }) },
  { name: 'Gemini input token count', error: normalizeGeminiError({ provider: 'gemini', status: 400, body: { error: { code: 400, message: 'The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } } }) },
  { name: 'llama.cpp exceed_context_size_error', error: http('llamacpp', 400, { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 5000, n_ctx: 4096 } }) },
  { name: 'llama.cpp older wording', error: http('llamacpp', 400, { error: { code: 400, message: 'the request exceeds the available context size. try increasing the context size or enable context shift', type: 'invalid_request_error' } }) },
  { name: 'llama.cpp mid-stream', error: direct('llamacpp', 'STREAM_ERROR', 'Context size has been exceeded.') },
  { name: 'LM Studio keep tokens', error: direct('lmstudio', 'INVALID_REQUEST', 'Trying to keep the first 4000 tokens when context overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input', 400) },
  { name: 'vLLM maximum context length', error: http('vllm', 400, { object: 'error', message: "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.", type: 'BadRequestError', param: null, code: 400 }) },
  { name: 'vLLM decoder prompt', error: http('vllm', 400, { object: 'error', message: 'The decoder prompt (length 5000) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.', type: 'BadRequestError', code: 400 }) },
  { name: 'vLLM max_tokens too large', error: http('vllm', 400, { object: 'error', message: "'max_tokens' or 'max_completion_tokens' is too large: 5000. This model's maximum context length is 4096 tokens and your request has 4000 input tokens (5000 > 4096 - 4000).", type: 'BadRequestError', code: 400 }) },
  { name: 'Ollama relayed body', error: direct('ollama', 'INVALID_REQUEST', 'Ollama responded 400: {"error":"prompt too long; exceeded max context length by 1234 tokens"}', 400) },
  { name: 'Ollama runtime failure', error: direct('ollama', 'LOCAL_RUNTIME_ERROR', 'Ollama responded 500: {"error":"the request exceeds the available context size"}', 500) },
  { name: 'Mistral too large for model', error: http('mistral', 400, { object: 'error', message: 'Prompt contains 140000 tokens and 0 draft tokens, too large for model with 128000 maximum context length', type: 'invalid_request_message_order' }) },
  { name: 'xAI maximum prompt length', error: http('xai', 400, { code: 'Client specified an invalid argument', error: 'This model\'s maximum prompt length is 131072 but the request contains 150000 tokens.' }) },
  { name: 'GitHub Copilot token count', error: http('copilot', 400, { error: { message: 'prompt token count of 140000 exceeds the limit of 128000', code: 'model_max_prompt_tokens_exceeded' } }) },
  { name: 'Cohere too many tokens', error: http('cohere', 400, { message: 'too many tokens: size limit exceeded by 12345 tokens' }) },
  { name: 'Moonshot token limit', error: http('moonshot', 400, { error: { message: 'Invalid request: Your request exceeded model token limit: 8192', type: 'invalid_request_error' } }) },
  { name: 'DashScope input length range', error: http('dashscope', 400, { error: { message: '<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 129024]', type: 'invalid_request_error' } }) },
  { name: 'MiniMax context window exceeds', error: http('minimax', 400, { error: { message: 'context window exceeds limit (2013)' } }) },
  { name: 'generic 413', error: http('custom', 413, 'Payload Too Large') }
]

const OTHERS: Case[] = [
  { name: 'Anthropic max_tokens output limit', error: http('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022' } }) },
  { name: 'Anthropic long context beta gate', error: http('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'The long context beta is not yet available for this subscription.' } }) },
  { name: 'Anthropic image too large', error: http('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes' } }) },
  { name: 'OpenAI single string too long', error: http('openai', 400, { error: { message: "Invalid 'messages[0].content': string too long. Expected a string with maximum length 1048576, but got a string with length 2000000 instead.", type: 'invalid_request_error', param: 'messages[0].content', code: 'string_above_max_length' } }) },
  { name: 'authentication', error: http('openai', 401, { error: { message: 'Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account/api-keys.', code: 'invalid_api_key' } }) },
  { name: 'rate limit on tokens per minute', error: http('openai', 429, { error: { message: 'Rate limit reached for gpt-4o in organization org-x on tokens per minute (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4s.', code: 'rate_limit_exceeded' } }) },
  { name: 'server error', error: http('anthropic', 500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }) },
  { name: 'overloaded', error: http('anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) },
  { name: 'content policy', error: http('openai', 400, { error: { message: 'Your request was rejected as a result of our safety system.', code: 'content_policy_violation' } }) },
  { name: 'model not found', error: http('openai', 404, { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } }) },
  { name: 'network failure', error: direct('openai', 'NETWORK_ERROR', 'fetch failed') },
  { name: 'timeout', error: direct('openai', 'TIMEOUT', 'The request timed out after 120000 ms.') },
  { name: 'cancelled', error: direct('openai', 'CANCELLED', 'The operation was aborted.') },
  { name: 'out of memory', error: direct('ollama', 'INSUFFICIENT_MEMORY', 'model requires more system memory (12.0 GiB) than is available (8.0 GiB)') },
  { name: 'invalid tool schema', error: http('openai', 400, { error: { message: "Invalid schema for function 'read_file': 'object' schema missing properties.", code: 'invalid_function_parameters' } }) },
  { name: 'unrelated mention of context', error: direct('openai', 'INVALID_REQUEST', 'Unsupported parameter: context. Remove it and try again.', 400) }
]

describe('isContextOverflow', () => {
  it.each(OVERFLOWS)('recognizes $name', ({ error }) => {
    expect(isContextOverflow(error)).toBe(true)
  })

  it.each(OTHERS)('does not treat $name as an overflow', ({ error }) => {
    expect(isContextOverflow(error)).toBe(false)
  })

  it('accepts a plain Error with the same wording, and rejects values that are not errors', () => {
    expect(isContextOverflow(new Error('prompt is too long: 300000 tokens > 200000 maximum'))).toBe(true)
    expect(isContextOverflow(new Error('socket hang up'))).toBe(false)
    expect(isContextOverflow(undefined)).toBe(false)
    expect(isContextOverflow(null)).toBe(false)
    expect(isContextOverflow('prompt is too long')).toBe(false)
  })

  it('never matches a rate limit or a cancellation whatever the wording says', () => {
    expect(isContextOverflow(direct('openai', 'RATE_LIMIT_ERROR', 'maximum context length is 4096 tokens', 429))).toBe(false)
    expect(isContextOverflow(direct('openai', 'CANCELLED', 'prompt is too long'))).toBe(false)
    expect(isContextOverflow(direct('openai', 'AUTHENTICATION_ERROR', 'prompt is too long', 401))).toBe(false)
  })
})

describe('normalizeHttpError for nested provider errors', () => {
  it('surfaces the upstream message of an OpenRouter wrapper', () => {
    const error = http('openrouter', 400, { error: { message: 'Provider returned error', code: 400, metadata: { raw: JSON.stringify({ error: { message: 'boom upstream' } }), provider_name: 'X' } } })
    expect(error.message).toContain('Provider returned error')
    expect(error.message).toContain('boom upstream')
  })

  it('reads a plain string error field', () => {
    expect(http('ollama', 400, { error: 'prompt too long; exceeded max context length by 5 tokens' }).message).toBe('prompt too long; exceeded max context length by 5 tokens')
  })

  it('leaves ordinary bodies as they were', () => {
    expect(http('openai', 400, { error: { message: 'Bad thing', code: 'bad' } }).message).toBe('Bad thing')
    expect(http('openai', 500, undefined).message).toBe('HTTP 500')
  })
})
