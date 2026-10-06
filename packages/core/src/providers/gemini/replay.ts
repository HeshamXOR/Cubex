/**
 * What a Gemini turn needs echoed back on the next request, kept in the
 * provider-agnostic message model without new fields:
 *  - thought signatures travel in `ReasoningPart.signature`, tagged so a signature
 *    another provider wrote is never sent to Gemini (a 400) and the reverse;
 *  - function calls have no required id, so one is synthesized deterministically
 *    (the harness keys tool activity and results by id).
 */

import type { AIRequest } from '../../types/request'

const SIGNATURE_TAG = 'gemini:'

/**
 * Gemini 3 validates that the first function call of each step in the current
 * turn carries a signature. A call the model did not make (a turn written by
 * another provider after a fallback, or one recovered from text) has none, and
 * this documented value tells the API to skip the check for it.
 */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator'

export function packGeminiSignature(signature: string): string {
  return `${SIGNATURE_TAG}${signature}`
}

/** The signature Gemini issued, or undefined for anything else (including no signature). */
export function unpackGeminiSignature(value: string | undefined): string | undefined {
  if (!value?.startsWith(SIGNATURE_TAG)) return undefined
  return value.length > SIGNATURE_TAG.length ? value.slice(SIGNATURE_TAG.length) : undefined
}

const SYNTHESIZED = 'gemini_call_'
const FROM_API = 'gemini_id_'
/** Other providers cap tool call ids near 40 characters and restrict the alphabet. */
const PORTABLE_ID = /^[A-Za-z0-9_-]{1,28}$/

/** JSON with sorted keys, so equal arguments hash equally whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** FNV-1a, 32 bit. Not cryptographic: it only has to spread ids apart. */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/**
 * The tool call id for a function call part. An id the API supplied is kept (and
 * echoed back in the function response); otherwise one is derived from where the
 * call sits in which response, its name and its arguments.
 */
export function geminiCallId(
  call: { id?: string; name: string; args: unknown },
  index: number,
  responseId?: string
): string {
  if (call.id && PORTABLE_ID.test(call.id) && FROM_API.length + call.id.length <= 38) return `${FROM_API}${call.id}`
  const material = `${responseId ?? ''}|${index}|${call.name}|${stableJson(call.args)}`
  return `${SYNTHESIZED}${hex8(fnv1a(material, 0x811c9dc5))}${hex8(fnv1a(material, 0x9747b28c))}`
}

/** The id the API itself issued for this tool call, if it was one of Gemini's. */
export function geminiApiCallId(toolUseId: string): string | undefined {
  return toolUseId.startsWith(FROM_API) && toolUseId.length > FROM_API.length ? toolUseId.slice(FROM_API.length) : undefined
}

/**
 * The same request with every Gemini-signed reasoning part removed, or the very
 * same object when there is none. A signature is only valid for the model that
 * issued it; when the API rejects one (a fallback to another Gemini model
 * mid-turn), the turn is replayed without them and translate.ts marks the calls
 * as not model-made instead.
 */
export function withoutGeminiSignatures(request: AIRequest): AIRequest {
  let changed = false
  const messages = request.messages.map((message) => {
    const content = message.content.filter((part) => part.type !== 'reasoning' || unpackGeminiSignature(part.signature) === undefined)
    if (content.length === message.content.length) return message
    changed = true
    return { ...message, content }
  })
  return changed ? { ...request, messages } : request
}
