/**
 * Claude Code's own protocol on its standard input and output, which Cubex drives directly: with `--input-format stream-json`
 * and `--output-format stream-json`, one JSON message per line each way, and with `--permission-prompt-tool stdio` it asks
 * the program on the other end before it uses a tool. This is what a program that hosts Claude Code speaks (the Claude Agent
 * SDK is this protocol in a library). Nothing here is trusted: a line is parsed as unknown data, and a message that is not
 * of a shape Cubex knows is ignored.
 */

import { isRecord } from '../acp/lines'

export { isRecord, LineSplitter, MAX_LINE_CHARS, parseMessage } from '../acp/lines'

// --- What Cubex sends --------------------------------------------------------------

export const userMessage = (text: string): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: ''
})

export const controlRequest = (requestId: string, request: Record<string, unknown>): Record<string, unknown> => ({ type: 'control_request', request_id: requestId, request })

export const allowTool = (requestId: string, input: unknown): Record<string, unknown> => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } }
})

export const denyTool = (requestId: string, message: string): Record<string, unknown> => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } }
})

/** The answer to a request Cubex does not serve, so Claude Code does not wait for one. */
export const refuseRequest = (requestId: string, error: string): Record<string, unknown> => ({
  type: 'control_response',
  response: { subtype: 'error', request_id: requestId, error }
})

// --- What Cubex reads --------------------------------------------------------------

/** Who Claude Code says it is signed in as. Only the way it got a credential is reported, never the credential. */
export interface ClaudeAccount {
  /** "none" when there is no login; otherwise where the token came from. */
  tokenSource?: string
  /** Where an API key came from, when one is used. */
  apiKeySource?: string
  /** "firstParty" for Anthropic itself, or the cloud that hosts the model: "bedrock", "vertex", "foundry". */
  apiProvider?: string
}

export function readAccount(value: unknown): ClaudeAccount | undefined {
  if (!isRecord(value)) return undefined
  const text = (entry: unknown): string | undefined => (typeof entry === 'string' && entry ? entry.slice(0, 80) : undefined)
  const account: ClaudeAccount = {}
  const tokenSource = text(value.tokenSource)
  const apiKeySource = text(value.apiKeySource)
  const apiProvider = text(value.apiProvider)
  if (tokenSource) account.tokenSource = tokenSource
  if (apiKeySource) account.apiKeySource = apiKeySource
  if (apiProvider) account.apiProvider = apiProvider
  return account
}

/**
 * Claude Code has no way to reach Anthropic: no login, no key, and it is not set up for a cloud that has its own. It says so
 * as `tokenSource: "none"`. A missing or unfamiliar report is not a reason to refuse: the first message finds out.
 */
export function isSignedOut(account: ClaudeAccount | undefined): boolean {
  if (!account || account.tokenSource !== 'none' || account.apiKeySource) return false
  return account.apiProvider === undefined || account.apiProvider === 'firstParty'
}

/** What Claude Code says in the place of an answer when it has no login. The words differ between versions, so a miss is just a failure. */
export function looksSignedOut(message: string): boolean {
  return /not logged in|please run \/login|invalid api key|oauth token has expired|authentication[_ ]error|\b401\b/i.test(message)
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal'

/** How a turn ended, in the protocol's words. */
export function stopReasonOf(result: Record<string, unknown>): StopReason {
  if (result.subtype === 'error_max_turns') return 'max_turn_requests'
  switch (result.stop_reason) {
    case 'max_tokens': return 'max_tokens'
    case 'refusal': return 'refusal'
    default: return 'end_turn'
  }
}
