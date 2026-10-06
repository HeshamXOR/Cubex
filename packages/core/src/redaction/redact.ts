/**
 * Secret redaction for logs and the developer inspector. API keys, tokens,
 * cookies and auth headers must never be displayed or logged.
 */

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /api[-_]?key/i,
  /x[-_]api[-_]key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /cookie/i,
  /set-cookie/i,
  /credential/i,
  /client[-_]?secret/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /session/i,
  /bearer/i
]

/** Value patterns that look like secrets even under an innocuous key. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic-style
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bhf_[A-Za-z0-9]{16,}\b/g, // Hugging Face token
  // Google API key (Gemini). Lookarounds rather than \b: the key may start or end with "-" or "_".
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g
]

export const REDACTED = '«redacted»'

export function redactString(input: string): string {
  let out = input
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED)
  }
  return out
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))
}

/** Redact HTTP headers by key. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined> | Headers | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const entries: Array<[string, unknown]> =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)
  for (const [k, v] of entries) {
    if (v === undefined) continue
    const value = Array.isArray(v) ? v.join(', ') : String(v)
    out[k] = isSensitiveKey(k) ? REDACTED : redactString(value)
  }
  return out
}

/** Deep-redact an arbitrary object graph (safe for circular refs). */
export function redactObject<T>(value: T, seen = new WeakSet<object>()): T {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (typeof value !== 'object') return value
  if (seen.has(value as object)) return '«circular»' as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, seen)) as unknown as T
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactObject(v, seen)
  }
  return out as unknown as T
}
