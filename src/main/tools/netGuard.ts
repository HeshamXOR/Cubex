import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'

/**
 * Outbound-request guard for agent tools. Two layers:
 *  1. `checkUrlSyntax` rejects schemes, credentials, internal-looking names and
 *     IP literals in non-public ranges (after WHATWG normalisation, so decimal,
 *     octal, hex and IPv4-mapped spellings are already canonical).
 *  2. `guardedLookup` is installed as the socket's DNS resolver, so the address
 *     actually connected to is validated at connect time. This closes DNS
 *     rebinding and redirect-to-internal attacks: every hop of a redirect chain
 *     opens a new connection that passes through the same check.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8]
] as const) blocked.addSubnet(net, prefix, 'ipv6')

/** Expand an IPv6 literal to 8 hextets (handles `::` and embedded dotted IPv4). */
function hextets(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number)
    text = text.slice(0, -dotted[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const [left, right] = text.split('::')
  const l = left ? left.split(':') : []
  const r = right !== undefined ? (right ? right.split(':') : []) : []
  const fill = text.includes('::') ? 8 - l.length - r.length : 0
  const all = [...l, ...Array(Math.max(0, fill)).fill('0'), ...r].map((h) => parseInt(h || '0', 16))
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : undefined
}

/** IPv4 embedded in mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16) forms. */
function embeddedIPv4(address: string): string | undefined {
  const h = hextets(address)
  if (!h) return undefined
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (h.slice(0, 5).every((n) => n === 0) && (h[5] === 0xffff || h[5] === 0)) return v4(h[6]!, h[7]!)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) return v4(h[6]!, h[7]!)
  if (h[0] === 0x2002) return v4(h[1]!, h[2]!)
  return undefined
}

export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!
  const family = isIP(bare)
  if (family === 4) return !blocked.check(bare, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIPv4(bare)
    if (v4 !== undefined) return isPublicAddress(v4)
    return !blocked.check(bare, 'ipv6')
  }
  return false
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private']

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

export function checkUrlSyntax(raw: string): UrlCheck {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, reason: 'not a valid URL' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http(s) URLs are allowed' }
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'missing host' }
  const literal = host.replace(/^\[|\]$/g, '')
  if (isIP(literal)) {
    return isPublicAddress(literal) ? { ok: true, url } : { ok: false, reason: 'that address is on the local/private network (or a reserved range)' }
  }
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: 'that host is on the local/private network' }
  }
  // Single-label names resolve through the local search domain (intranet, router, …).
  if (!host.includes('.')) return { ok: false, reason: 'single-label (intranet) host names are not allowed' }
  return { ok: true, url }
}

/** DNS resolver for http(s).request that refuses any non-public answer. */
export function guardedLookup(
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as LookupAddress[]
    const bad = list.find((entry) => !isPublicAddress(entry.address))
    if (!list.length || bad) {
      const refusal = Object.assign(new Error(`${hostname} resolves to a non-public address on the local/private network${bad ? ` (${bad.address})` : ''}`), { code: 'EBLOCKEDHOST' })
      return callback(refusal, '', 0)
    }
    if ((options as { all?: boolean }).all) return callback(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}
