import { createHash } from 'node:crypto'

/**
 * Provider-safe names for MCP tools: mcp__<server>__<tool>. OpenAI-style APIs
 * accept only [a-zA-Z0-9_-] up to 64 characters and reject the whole request for
 * one bad name, so every name is sanitized, bounded, and made unique here. The
 * result depends only on the input names (never on listing order), so the same
 * server always yields the same tool names, which keeps saved permission rules valid.
 */

export const MCP_TOOL_PREFIX = 'mcp__'
export const MAX_TOOL_NAME_LENGTH = 64
const SEPARATOR = '__'
const MAX_SERVER_SEGMENT = 24
const HASH_LENGTHS = [6, 8, 10, 12, 16]

function digest(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

/** Strip diacritics so accented letters survive as their ASCII base. */
function asciiBase(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '')
}

function trimEdges(text: string): string {
  return text.replace(/^[_-]+|[_-]+$/g, '')
}

/** Server segment: lower case, no double underscore, no leading or trailing separator. */
function serverSlug(text: string): string {
  return trimEdges(asciiBase(text).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_{2,}/g, '_'))
}

function toolSlug(text: string): string {
  return asciiBase(text).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** `base` shortened so that `base + "_" + hash` fits in `max` characters. */
function withHash(base: string, key: string, max: number, hashLength: number): string {
  const suffix = `_${digest(key, hashLength)}`
  const kept = base.slice(0, Math.max(1, max - suffix.length))
  return `${kept}${suffix}`
}

/** Distinct, valid server segments for a set of servers. Order of the input does not matter. */
export function assignServerSegments(servers: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const byId = new Map<string, string>()
  for (const server of servers) {
    if (byId.has(server.id)) continue
    byId.set(server.id, trimEdges(serverSlug(server.name).slice(0, MAX_SERVER_SEGMENT)) ||
      trimEdges(serverSlug(server.id).slice(0, MAX_SERVER_SEGMENT)) || 'server')
  }
  const counts = new Map<string, number>()
  for (const base of byId.values()) counts.set(base, (counts.get(base) ?? 0) + 1)
  const out = new Map<string, string>()
  const used = new Set<string>()
  // Sorted by id so a residual clash resolves the same way every run.
  for (const [id, base] of [...byId].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    let segment = base
    if ((counts.get(base) ?? 0) > 1) segment = withHash(base, id, MAX_SERVER_SEGMENT, HASH_LENGTHS[0]!)
    for (let i = 1; used.has(segment) && i < HASH_LENGTHS.length; i++) segment = withHash(base, id, MAX_SERVER_SEGMENT, HASH_LENGTHS[i]!)
    used.add(segment)
    out.set(id, segment)
  }
  return out
}

/** Distinct, valid, at most 64 character names for one server's tools, keyed by the original tool name. */
export function assignToolNames(serverSegment: string, toolNames: readonly string[]): Map<string, string> {
  const prefix = `${MCP_TOOL_PREFIX}${serverSegment}${SEPARATOR}`
  const originals = [...new Set(toolNames)].sort()
  const fit = (base: string, original: string, hashLength: number): string =>
    `${prefix}${withHash(base, `${serverSegment}\u0000${original}`, Math.max(2, MAX_TOOL_NAME_LENGTH - prefix.length), hashLength)}`

  const plain = new Map<string, string>() // original -> sanitized base
  const candidates = new Map<string, string>() // original -> candidate full name
  for (const original of originals) {
    const base = toolSlug(original) || '_'
    plain.set(original, base)
    const full = `${prefix}${base}`
    candidates.set(original, full.length <= MAX_TOOL_NAME_LENGTH ? full : fit(base, original, HASH_LENGTHS[0]!))
  }

  const sharing = new Map<string, number>()
  for (const full of candidates.values()) sharing.set(full, (sharing.get(full) ?? 0) + 1)
  for (const original of originals) {
    if ((sharing.get(candidates.get(original)!) ?? 0) > 1) candidates.set(original, fit(plain.get(original)!, original, HASH_LENGTHS[0]!))
  }

  // A hashed name can still equal another candidate (vanishingly rare): widen the hash until unique.
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const original of originals) {
    let name = candidates.get(original)!
    for (let i = 1; used.has(name) && i < HASH_LENGTHS.length; i++) name = fit(plain.get(original)!, original, HASH_LENGTHS[i]!)
    used.add(name)
    out.set(original, name.slice(0, MAX_TOOL_NAME_LENGTH))
  }
  return out
}

/** Split a generated name into its server segment and tool part. */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const index = rest.indexOf(SEPARATOR)
  if (index <= 0) return undefined
  return { server: rest.slice(0, index), tool: rest.slice(index + SEPARATOR.length) }
}
