import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import { checkUrlSyntax, guardedLookup } from './netGuard'

const MAX_BYTES = 2_000_000
const MAX_TEXT = 50_000
const TIMEOUT = 20_000
const MAX_REDIRECTS = 5

export { checkUrlSyntax } from './netGuard'

/**
 * Documentation hosts that may be fetched without a prompt. Everything else asks
 * once per host per turn: an unprompted GET to an arbitrary host is a data
 * exfiltration channel (query strings) for prompt-injected instructions.
 */
export const PREAPPROVED_FETCH_HOSTS = [
  'developer.mozilla.org', 'docs.python.org', 'nodejs.org', 'www.typescriptlang.org', 'react.dev', 'vitejs.dev',
  'docs.rs', 'doc.rust-lang.org', 'go.dev', 'pkg.go.dev', 'learn.microsoft.com', 'docs.github.com',
  'platform.openai.com', 'docs.anthropic.com', 'docs.claude.com', 'platform.claude.com', 'www.electronjs.org'
]

export function fetchHost(input: unknown): string | undefined {
  const url = (input as { url?: unknown } | null)?.url
  if (typeof url !== 'string') return undefined
  const check = checkUrlSyntax(url)
  return check.ok ? check.url.hostname.toLowerCase().replace(/\.$/, '') : undefined
}

/** Crude but dependency-free HTML → readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Fetched { url: URL; status: number; statusText: string; contentType: string; body: Buffer; truncated: boolean; redirectedTo?: string }

/** Same site for redirect purposes: identical host, or only a leading `www.` differs. */
function sameSite(a: URL, b: URL): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')
  return bare(a.hostname) === bare(b.hostname)
}

/** One hop. DNS is resolved through guardedLookup, so the connected IP is always public. */
function fetchOnce(url: URL, signal: AbortSignal): Promise<{ res: IncomingMessage; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      lookup: guardedLookup as never,
      signal,
      headers: { 'user-agent': 'Cubex/0.1', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'identity' }
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      res.on('data', (chunk: Buffer) => {
        if (truncated) return
        size += chunk.length
        if (size > MAX_BYTES) {
          truncated = true
          chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES)))
          res.destroy() // stop downloading; never buffer an unbounded body
          resolve({ res, body: Buffer.concat(chunks), truncated })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks), truncated }))
      res.on('error', (error) => { if (!truncated) reject(error) })
    })
    request.on('error', reject)
    request.end()
  })
}

export async function safeFetch(raw: string, external?: AbortSignal): Promise<Fetched> {
  const signal = external ? AbortSignal.any([external, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT)
  let current = raw
  let origin: URL | undefined
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkUrlSyntax(current)
    if (!check.ok) throw Object.assign(new Error(check.reason), { code: 'EBLOCKEDHOST' })
    origin ??= check.url
    const { res, body, truncated } = await fetchOnce(check.url, signal)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      // Every hop is re-validated (syntax here, resolved address in guardedLookup).
      const next = new URL(res.headers.location, check.url)
      // Approval is per host: an open redirect on an approved or allowlisted
      // host must not become an unprompted channel to another one.
      if (!sameSite(origin, next)) {
        return { url: check.url, status, statusText: res.statusMessage ?? '', contentType: '', body: Buffer.alloc(0), truncated: false, redirectedTo: next.href }
      }
      current = next.href
      continue
    }
    return { url: check.url, status, statusText: res.statusMessage ?? '', contentType: String(res.headers['content-type'] ?? ''), body, truncated }
  }
  throw Object.assign(new Error(`more than ${MAX_REDIRECTS} redirects`), { code: 'EBLOCKEDHOST' })
}

/**
 * `web_fetch` — fetch a public URL and return its readable text. Approval is
 * decided by ChatService per host (see PREAPPROVED_FETCH_HOSTS).
 */
export function createWebFetchTool(): ExecutableTool {
  return {
    definition: {
      name: 'web_fetch',
      description:
        'Fetch a public http(s) URL and return its readable text content (documentation, a spec, an API ' +
        'reference, a raw file). HTML is reduced to text; large pages are truncated. Local/private addresses ' +
        'are blocked. Hosts outside a small documentation allowlist require user approval.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The absolute http(s) URL to fetch.' } },
        required: ['url']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx?: ToolExecutionContext): Promise<ToolResult> {
      const { url } = (input ?? {}) as { url?: string }
      if (typeof url !== 'string' || !url) return { toolUseId: '', content: 'web_fetch requires a "url".', isError: true }
      try {
        const res = await safeFetch(url, ctx?.signal)
        if (res.redirectedTo) {
          return { toolUseId: '', content: `${res.url.href} redirects to a different host: ${res.redirectedTo}\nCall web_fetch with that URL if you still need it.`, isError: false }
        }
        const raw = res.body.toString('utf8')
        const text = /html/i.test(res.contentType) ? htmlToText(raw) : raw.trim()
        const clipped = text.length > MAX_TEXT || res.truncated ? `${text.slice(0, MAX_TEXT)}\n… [truncated]` : text
        const status = `${res.status} ${res.statusText} · ${res.contentType.split(';')[0] || 'unknown'}`
        return { toolUseId: '', content: `Fetched ${res.url.href} (${status})\n\n${clipped || '(empty response)'}`, isError: res.status < 200 || res.status >= 300 }
      } catch (e) {
        const error = e as Error & { code?: string }
        const msg = error.code === 'EBLOCKEDHOST' ? error.message
          : error.name === 'TimeoutError' || error.name === 'AbortError' ? (ctx?.signal?.aborted ? 'cancelled' : `timed out after ${TIMEOUT}ms`)
          : error.message
        return { toolUseId: '', content: `web_fetch ${error.code === 'EBLOCKEDHOST' ? 'refused' : 'failed'}: ${msg}`, isError: true }
      }
    }
  }
}
