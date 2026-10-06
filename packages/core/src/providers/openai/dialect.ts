/**
 * What an OpenAI Chat Completions server will take beyond the fields every
 * server shares. The wire format is copied widely, but hosts differ at the
 * edges: some reject fields they do not know, others want a field the baseline
 * never mentions. So each extra is decided per host, and a server that still
 * refuses one is read from its error (see `chatExtrasRejected`).
 */
import type { ChatCompletionsBody } from './translate'

/** The optional request fields that are not safe to send to every server. */
export type ChatExtra = 'stream_options' | 'metadata' | 'reasoning_content' | 'reasoning_effort'

export interface ChatDialect {
  /** `stream_options.include_usage`: most servers end a stream without token usage unless asked. */
  streamUsage: boolean
  /** `metadata`: an OpenAI field. Elsewhere it is ignored at best and a 400 at worst. */
  metadata: boolean
  /** `reasoning_content` on assistant messages: thinking-mode servers (DeepSeek, Kimi) want it back. */
  reasoningContent: boolean
  /**
   * `reasoning_effort`: sent whenever an effort is chosen, which is the default
   * here. Compatible servers list no capabilities, so the picker is offered on
   * a guess; a server that does not know the field is asked again without it.
   */
  reasoningEffort?: boolean
}

const OFFICIAL_OPENAI = 'api.openai.com'

/** Lower-cased host of a base URL; an absent URL is OpenAI itself, an unparsable one is unknown. */
function hostOf(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return OFFICIAL_OPENAI
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** Hosts of the two APIs whose thinking modes expect `reasoning_content` back. */
const isDeepSeekHost = (host: string): boolean => onDomain(host, 'deepseek.com')
const isMoonshotHost = (host: string): boolean =>
  ['moonshot.ai', 'moonshot.cn', 'kimi.com', 'kimi.ai'].some((domain) => onDomain(host, domain))

/** Model ids of those families, for gateways and self-hosted servers that front them. */
const THINKING_FAMILY = /deepseek|kimi|moonshot/i

/**
 * The extras to try for this host and model. Official OpenAI takes everything
 * but `reasoning_content`; DeepSeek and Moonshot want it; other hosts get stream
 * usage (nearly all accept it, and the context meter needs the counts) and
 * nothing else. A host that turns out to refuse one is handled by the caller.
 */
export function chatDialect(baseUrl: string | undefined, model: string): ChatDialect {
  const host = hostOf(baseUrl)
  const openai = onDomain(host, OFFICIAL_OPENAI)
  return {
    // Mistral's API validates strictly and already ends streams with usage.
    streamUsage: !onDomain(host, 'mistral.ai'),
    metadata: openai,
    reasoningContent: !openai && (isDeepSeekHost(host) || isMoonshotHost(host) || THINKING_FAMILY.test(model))
  }
}

/** Which extras a request body actually carries, so a refusal is only ever matched against what was sent. */
export function chatExtrasSent(body: ChatCompletionsBody): ChatExtra[] {
  const sent: ChatExtra[] = []
  if (body.stream_options !== undefined) sent.push('stream_options')
  if (body.metadata !== undefined) sent.push('metadata')
  if (body.messages.some((message) => message.reasoning_content !== undefined)) sent.push('reasoning_content')
  if (body.reasoning_effort !== undefined) sent.push('reasoning_effort')
  return sent
}

const EXTRA_NAMES: Record<ChatExtra, RegExp> = {
  stream_options: /stream_options|include_usage/i,
  metadata: /\bmetadata\b/i,
  reasoning_content: /reasoning_content/i,
  reasoning_effort: /reasoning[_.]effort/i
}

/** How servers say a field is unknown or not allowed, across the OpenAI, pydantic and gateway styles. */
const REFUSAL =
  /unrecogni[sz]ed|unknown (?:field|param|parameter|argument|key|property)|invalid (?:param|parameter|argument|field|key|property)|unexpected|unsupported|not (?:supported|allowed|permitted|recogni[sz]ed)|extra[ _](?:inputs?|fields?|forbidden)|additional propert/i

/** A server asking FOR a field says it is missing or must be sent. That is not a refusal. */
const WANTS = /missing|must be passed|is required/i

/**
 * Which of the `sent` extras a failed request says the server refuses. Only a
 * 400 or 422 counts, the message must name the field, and it must say the field
 * is unknown: DeepSeek and Kimi 400 when `reasoning_content` is absent, and that
 * message names it too. Messages are for people, so only stable words are matched.
 */
export function chatExtrasRejected(
  status: number | undefined,
  message: string,
  sent: readonly ChatExtra[]
): ChatExtra[] {
  if (status !== 400 && status !== 422) return []
  if (!REFUSAL.test(message) || WANTS.test(message)) return []
  return sent.filter((extra) => EXTRA_NAMES[extra].test(message))
}

/**
 * The dialect to send each model, narrowed by what its server has refused so
 * far. Refusals are kept per model: a gateway can front servers that differ.
 */
export class ChatDialects {
  private readonly refused = new Map<string, Set<ChatExtra>>()

  constructor(private readonly baseUrl: string | undefined) {}

  for(model: string): ChatDialect {
    const dialect = chatDialect(this.baseUrl, model)
    const refused = this.refused.get(model)
    if (!refused) return dialect
    return {
      streamUsage: dialect.streamUsage && !refused.has('stream_options'),
      metadata: dialect.metadata && !refused.has('metadata'),
      reasoningContent: dialect.reasoningContent && !refused.has('reasoning_content'),
      reasoningEffort: !refused.has('reasoning_effort')
    }
  }

  refuse(model: string, extras: readonly ChatExtra[]): void {
    const refused = this.refused.get(model) ?? new Set<ChatExtra>()
    for (const extra of extras) refused.add(extra)
    this.refused.set(model, refused)
  }
}
