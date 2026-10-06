/**
 * How long one reply may run. Anthropic requires a limit on every request and other providers apply their own
 * default (NVIDIA's is small), so a reply that is not given a number gets cut off mid-file. Cubex therefore always
 * sends a number: what the person chose, or this one when they left it on Automatic.
 */

/** 32,000 fits every current Claude model (Opus 4.x allows exactly that many) and leaves room for a whole source file or page. */
export const AUTO_OUTPUT_TOKENS = 32_000

/** The most Cubex raises an Automatic limit to by itself, after a reply was cut off in the middle of a tool call. */
export const ESCALATED_OUTPUT_TOKENS = 64_000

const validLimit = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** What a request is allowed to generate: the person's number, else the automatic size, never above what the model can produce. */
export function resolveOutputLimit(requested: number | undefined, modelMax: number | undefined): number {
  const wanted = validLimit(requested) ? Math.floor(requested) : AUTO_OUTPUT_TOKENS
  return validLimit(modelMax) ? Math.min(wanted, Math.floor(modelMax)) : wanted
}

/** A higher limit to retry a cut-off reply with, or undefined when there is no more room to give. */
export function escalatedOutputLimit(current: number, modelMax: number | undefined): number | undefined {
  const ceiling = validLimit(modelMax) ? Math.min(Math.floor(modelMax), ESCALATED_OUTPUT_TOKENS) : ESCALATED_OUTPUT_TOKENS
  return current < ceiling ? ceiling : undefined
}

const LIMIT_PARAMETER = /max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|output tokens|completion tokens/i
const MIN_PLAUSIBLE_LIMIT = 256

/** What a provider that refused the limit says it allows, read from its error message (undefined when it names no number). */
export function outputLimitFromError(message: string): number | undefined {
  if (!LIMIT_PARAMETER.test(message)) return undefined
  const found = (...patterns: RegExp[]): number | undefined => {
    for (const pattern of patterns) {
      const match = pattern.exec(message)
      const value = match?.[1] ? Number(match[1].replace(/,/g, '')) : NaN
      if (Number.isSafeInteger(value) && value >= MIN_PLAUSIBLE_LIMIT) return value
    }
    return undefined
  }
  // Anthropic: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for model-x"
  const direct = found(
    /max_tokens:\s*[\d,]+\s*>\s*([\d,]+)/i,
    /supports at most\s*([\d,]+)\s*(?:completion|output)?\s*tokens/i,
    /maximum allowed number of output tokens[^.\d]*?(?:is|of)?\s*([\d,]{3,})/i,
    /less than or equal to\s*([\d,]+)/i,
    /(?:must be|should be|can be)\s*(?:at most|no more than|<=)\s*([\d,]+)/i,
    /(?:limit|maximum|max) (?:output|completion) tokens?[^\d.]{0,24}([\d,]{3,})/i
  )
  if (direct !== undefined) return direct
  // vLLM and NVIDIA: the window minus what the prompt already uses is what is left to generate.
  const window = /maximum context length is\s*([\d,]+)\s*tokens[^.]*?(?:has|contains|of)\s*([\d,]+)\s*(?:input\s*)?tokens/i.exec(message)
  if (window) {
    const left = Number(window[1]!.replace(/,/g, '')) - Number(window[2]!.replace(/,/g, ''))
    if (Number.isSafeInteger(left) && left >= MIN_PLAUSIBLE_LIMIT) return left
  }
  return undefined
}
