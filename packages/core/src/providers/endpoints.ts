import type { NormalizedAIError } from '../types/errors'

/** The three wire formats a model gateway can offer one model on. */
export type ModelEndpoint = 'chat' | 'responses' | 'anthropic'

/** How New-API style gateways name them in `supported_endpoint_types`. Image and other non-chat endpoints have no entry. */
const WIRE_NAMES: Readonly<Record<string, ModelEndpoint>> = {
  openai: 'chat',
  'openai-response': 'responses',
  anthropic: 'anthropic'
}

/**
 * The chat endpoints a model list reports for one model. `undefined` means the list says nothing about endpoints, which
 * is most servers. An empty list means it does say, and none of them chat: an image model, which has no place in a chat.
 */
export function endpointsFromList(types: unknown): ModelEndpoint[] | undefined {
  if (!Array.isArray(types)) return undefined
  const found = new Set<ModelEndpoint>()
  for (const type of types) {
    const endpoint = typeof type === 'string' ? WIRE_NAMES[type.toLowerCase()] : undefined
    if (endpoint) found.add(endpoint)
  }
  return [...found]
}

const CLAUDE = /(?:^|[/:_.-])claude[-_.]/i
/** Models OpenAI built around the Responses API. gpt-oss is an open model served by other people's stacks. */
const OPENAI_NATIVE = /(?:^|[/:])(?:gpt-(?!oss)|o[1-9](?:$|[-_.])|codex)/i

/** The format a model's maker designed it for: prompt caching, signed thinking and tool formats work best there. */
function nativeEndpoint(modelId: string): ModelEndpoint {
  if (CLAUDE.test(modelId)) return 'anthropic'
  if (OPENAI_NATIVE.test(modelId)) return 'responses'
  return 'chat'
}

/**
 * The endpoints to try for a model, best first. With a reported list the model's native format comes first and the others
 * follow as failovers. With no list, a Claude model tries the Messages API (a host without it answers 404 once, and that
 * is remembered) and everything else stays on Chat Completions, the one format every compatible server has.
 */
export function preferredEndpoints(modelId: string, reported?: readonly ModelEndpoint[]): ModelEndpoint[] {
  const native = nativeEndpoint(modelId)
  if (!reported) return native === 'anthropic' ? ['anthropic', 'chat'] : ['chat']
  const order: ModelEndpoint[] = [native, 'chat', 'responses', 'anthropic']
  return [...new Set(order)].filter((endpoint) => reported.includes(endpoint))
}

const ENDPOINT_PATHS: ReadonlyArray<readonly [RegExp, ModelEndpoint]> = [
  [/\/chat\/completions\b|\bchat[ _-]completions\b/i, 'chat'],
  [/\/responses\b|\bresponses[ _-]?api\b/i, 'responses'],
  [/\/messages\b|\bmessages[ _-]?api\b/i, 'anthropic']
]

/**
 * What a refusal says about where the model does work: "The model is not available on this endpoint. Use:
 * /v1/chat/completions, /v1/messages." Empty when the error is not such a refusal. Only client errors count: a 5xx is about
 * the server's state, not about the model, however its text reads.
 */
export function endpointsNamedInRefusal(status: number | undefined, message: string): ModelEndpoint[] {
  if (status !== 400 && status !== 404 && status !== 405) return []
  // "/v1/chat/completions does not work for this model. Use POST /v1/responses instead." names both: what follows "use" is the answer.
  const answer = /\buse\b(.*)$/is.exec(message)?.[1] ?? message
  return ENDPOINT_PATHS.filter(([pattern]) => pattern.test(answer)).map(([, endpoint]) => endpoint)
}

/** The server is alive and declining work for now: worth another endpoint at once, and another try later. */
export function isBusyError(error: Pick<NormalizedAIError, 'statusCode' | 'rawCode' | 'message'>): boolean {
  if (error.statusCode === 503 || error.statusCode === 529) return true
  return /overloaded/i.test(error.rawCode ?? '') || /temporarily (?:busy|unavailable)|overloaded|at capacity/i.test(error.message)
}

/** A failure on one endpoint that says nothing about the others: it is down right now. */
export function endpointFailed(error: Pick<NormalizedAIError, 'statusCode' | 'rawCode' | 'message'>): boolean {
  return isBusyError(error) || error.statusCode === 502 || error.statusCode === 504
}

/** The root of a base URL, for the Messages API: its SDK adds /v1 itself, and a gateway's address usually ends in it. */
export function withoutVersionPath(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/i, '')
}
