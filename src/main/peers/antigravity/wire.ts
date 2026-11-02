import { isRecord } from '../acp/lines'

/**
 * What Google's Antigravity runtime says that Cubex has to put in order before the rest of Cubex reads it. The runtime speaks the
 * Agent Client Protocol, but it names the fields of its own tools its own way, sends questions for the person in the place of
 * permission requests, and can send a very large tool result. Ported from the T3 Code project (github.com/pingdotgg/t3code, MIT
 * licence, Copyright (c) 2026 T3 Tools Inc.); see THIRD_PARTY_NOTICES.md.
 */

const TEXT_LIMIT = 8_000
const TRUNCATED = '[Earlier output truncated]\n\n'
const VALUE_NODES = 512
const VALUE_TEXT = 64_000
const VALUE_DEPTH = 12
const CONTENT_ENTRIES = 50

/** The end of a long text, which is the part that tells how a command finished. */
export function boundText(text: string, limit = TEXT_LIMIT): string {
  return text.length <= limit ? text : `${TRUNCATED}${text.slice(-limit)}`
}

interface Budget {
  nodes: number
  text: number
}

/** A copy of a value that is no larger than the budget: no pictures, long texts cut, only so many entries and so deep. */
function bounded(value: unknown, budget: Budget, depth: number): unknown {
  if (depth > VALUE_DEPTH || budget.nodes-- <= 0) return undefined
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value) || budget.text <= 0) return undefined
    const text = boundText(value, Math.min(TEXT_LIMIT, budget.text))
    budget.text -= text.length
    return text
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const entry of value) {
      if (budget.nodes <= 0) break
      const kept = bounded(entry, budget, depth + 1)
      if (kept !== undefined) out.push(kept)
    }
    return out
  }
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break
    // A picture's bytes are not something a card shows, and one is enough to fill the budget.
    if ((value.type === 'image' && (key === 'data' || key === 'blob')) || (key === 'blob' && typeof value.mimeType === 'string' && value.mimeType.startsWith('image/'))) continue
    // The same output twice is once too many.
    if ((key === 'formatted_output' || key === 'formattedOutput') && (entry === value.combinedOutput || entry === value.combined_output)) continue
    const kept = bounded(entry, budget, depth + 1)
    if (kept !== undefined) out[key] = kept
  }
  return out
}

export function boundedPayload(value: unknown): unknown {
  return bounded(value, { nodes: VALUE_NODES, text: VALUE_TEXT }, 0)
}

const COMMAND_FIELDS = ['CommandLine', 'command_line', 'commandLine', 'command'] as const

/** The command a tool call runs, whichever of the names the runtime used for it. */
export function commandOf(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined
  for (const field of COMMAND_FIELDS) {
    const value = rawInput[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * A tool call, from an update or a permission request, in the shape the rest of Cubex reads: its input is cut to a size, the
 * command is in `rawInput.command` whatever the runtime called it, and a call that has a command and no kind is a command.
 */
export function normalizeToolCall(toolCall: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...toolCall }
  if (typeof toolCall.title === 'string') out.title = boundText(toolCall.title)
  if (toolCall.rawInput !== undefined) {
    const input = boundedPayload(toolCall.rawInput)
    const command = commandOf(input)
    out.rawInput = command !== undefined && isRecord(input) && typeof input.command !== 'string' ? { ...input, command: boundText(command) } : input
    if (command !== undefined && typeof toolCall.kind !== 'string') out.kind = 'execute'
  }
  if (toolCall.rawOutput !== undefined) out.rawOutput = boundedPayload(toolCall.rawOutput)
  if (Array.isArray(toolCall.content)) {
    const budget = { nodes: VALUE_NODES, text: 32_000 }
    out.content = toolCall.content.slice(0, CONTENT_ENTRIES).map((entry) => bounded(entry, budget, 0)).filter((entry) => entry !== undefined)
  }
  if (toolCall._meta !== undefined) out._meta = boundedPayload(toolCall._meta)
  return out
}

/** A `session/update` with its tool call put in order. Updates of any other kind are as they came. */
export function normalizeSessionUpdate(params: unknown): unknown {
  if (!isRecord(params) || !isRecord(params.update)) return params
  const kind = params.update.sessionUpdate
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return params
  return { ...params, update: normalizeToolCall(params.update) }
}

/** The runtime asks the person things through the permission method too; those calls are named "interaction_...". */
export function isInteraction(params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params.toolCall)) return false
  return typeof params.toolCall.toolCallId === 'string' && params.toolCall.toolCallId.startsWith('interaction_')
}

/** A permission request with its tool call put in order. */
export function normalizePermissionRequest(params: unknown): unknown {
  if (!isRecord(params) || !isRecord(params.toolCall)) return params
  return { ...params, toolCall: normalizeToolCall(params.toolCall) }
}

/** The one way in Cubex uses: signing in with a Google account. The others, a key or a cloud project, are not offered. */
export const PERSONAL_SIGN_IN = 'oauth-personal'

/** The handshake's answer with only the way to sign in that Cubex uses, so the client picks it without asking. */
export function onlyPersonalSignIn(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.authMethods)) return result
  const personal = result.authMethods.filter((method) => isRecord(method) && (method.id === PERSONAL_SIGN_IN || method.methodId === PERSONAL_SIGN_IN))
  return personal.length > 0 ? { ...result, authMethods: personal } : result
}
