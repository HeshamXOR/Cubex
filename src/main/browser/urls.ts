/**
 * Which addresses the browser may open, and which need the person first. A page on this machine is the agent's own work, so
 * it opens freely. Anything else asks once per host, like web_fetch: a page can read what the agent types into it, and a
 * URL can carry data away.
 */

const LOCAL_NAME = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

export function isLocalHost(hostname: string): boolean {
  return LOCAL_NAME.test(hostname)
}

/** The bare name of a host, as compared everywhere: lower case, no trailing dot. */
export function normalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

/** The two names are one site: identical, or only a leading `www.` differs. */
export function sameSite(a: string, b: string): boolean {
  const bare = (host: string): string => normalHost(host).replace(/^www\./, '')
  return bare(a) === bare(b)
}

/**
 * What the agent or the person typed, as a URL the browser may open: http or https with no credentials. A bare `localhost:3000`
 * is http and a bare `example.com` is https, the way an address bar reads them.
 */
export function parseBrowserUrl(input: unknown): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'Give the address to open.' }
  const text = input.trim()
  if (text.length > 4096) return { ok: false, reason: 'That address is too long.' }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:file|data|javascript|about|blob|chrome|devtools):/i.test(text)
  const bare = text.split(/[/?#]/)[0]!.replace(/:\d+$/, '')
  const candidate = hasScheme ? text : `${isLocalHost(bare) ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: `"${text.slice(0, 200)}" is not an address.` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `Only http and https pages can be opened, not ${url.protocol}` }
  if (url.username || url.password) return { ok: false, reason: 'An address with a user name or password in it cannot be opened.' }
  return { ok: true, url }
}

/** A browser call the person has to approve the host of. Pages on this machine and every other action return undefined. */
export function browserApprovalHost(input: unknown): string | undefined {
  const call = input as { action?: unknown; url?: unknown } | null
  if (call?.action !== 'navigate') return undefined
  const parsed = parseBrowserUrl(call.url)
  if (!parsed.ok || isLocalHost(parsed.url.hostname)) return undefined
  return normalHost(parsed.url.hostname)
}

/** A call that acts on the page rather than looking at it, which plan mode does not allow. */
export function browserCallActs(input: unknown): boolean {
  const action = (input as { action?: unknown } | null)?.action
  return action === 'click' || action === 'type'
}
