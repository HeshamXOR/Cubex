import type { ErrorCategory } from '../types/errors'

/**
 * Recognizes "the request does not fit the model's window": the one provider
 * failure a harness can repair by shrinking the conversation and trying again.
 *
 * Providers disagree on how they say it. Some give it a code the normalizer
 * already maps to CONTEXT_LENGTH; most send a plain 400 whose only signal is the
 * wording, and local servers add their own. The patterns below were recorded
 * from real error bodies (see overflow.test.ts for the table). They are only
 * read on categories that can carry such a message, so a rate limit that talks
 * about tokens per minute is never mistaken for an overflow.
 */

/** Categories whose message may be an overflow. Auth, rate limit, timeout and cancel never are. */
const MESSAGE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'INVALID_REQUEST', 'UNKNOWN', 'SERVER_ERROR', 'STREAM_ERROR', 'LOCAL_RUNTIME_ERROR'
])

const MESSAGE_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic, Vertex and Bedrock Claude, Ollama
  /input is too long for requested model/i, // Bedrock
  /input length and .{0,3}max_tokens.{0,3} exceed context limit/i, // Anthropic: input plus max_tokens
  /maximum context length/i, // OpenAI, Azure, OpenRouter, vLLM, DeepSeek, Mistral
  /maximum prompt length/i, // xAI
  /exceeded max context length/i, // Ollama
  /exceeds? the (?:available )?context (?:size|window|length)/i, // llama.cpp, OpenAI Responses
  /context size has been exceeded/i, // llama.cpp, LM Studio mid-stream
  /context window exceeds/i, // MiniMax
  /context overflows/i, // LM Studio
  /longer than the maximum model length/i, // vLLM
  /input tokens exceed the configured limit/i, // Azure
  /token count\b.{0,60}\bexceeds\b/i, // Gemini, GitHub Copilot
  /too many tokens/i, // Cohere
  /exceeded model token limit/i, // Moonshot
  /range of input length/i // DashScope
]

/** Provider codes that say it without any wording. */
const CODE_PATTERN = /^(?:exceed_context_size_error|model_max_prompt_tokens_exceeded|prompt_too_long|input_too_long)$/i

interface ErrorLike { message: string; category?: unknown; rawCode?: unknown }

function errorLike(value: unknown): ErrorLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { message?: unknown }).message === 'string' ? (value as ErrorLike) : undefined
}

/**
 * True when `error` is the provider saying the request is larger than the
 * model's context window. Accepts a normalized error (the usual case) or any
 * error object with a message, and is false for everything else.
 */
export function isContextOverflow(error: unknown): boolean {
  const candidate = errorLike(error)
  if (!candidate) return false
  const category = typeof candidate.category === 'string' ? (candidate.category as ErrorCategory) : 'UNKNOWN'
  if (category === 'CONTEXT_LENGTH') return true
  if (!MESSAGE_CATEGORIES.has(category)) return false
  if (typeof candidate.rawCode === 'string' && CODE_PATTERN.test(candidate.rawCode)) return true
  return MESSAGE_PATTERNS.some((pattern) => pattern.test(candidate.message))
}
