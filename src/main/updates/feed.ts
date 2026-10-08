import { UPDATE_REPOSITORY } from '@shared/updates'

/**
 * Where new releases are read from, and which addresses a release may point at. Everything a release says about
 * itself is untrusted text, so each address it carries is held to this before anything is opened or downloaded.
 */
export interface ReleaseFeed {
  /** The address of the latest release, as GitHub's releases API answers it. */
  url: string
  /** A release page or an installer must be on this origin... */
  origin: string
  /** ...and under this path. */
  pagePrefix: string
  /** The installer's address must start with this path. */
  downloadPrefix: string
  /** Whether a download may be sent on to this host (a `host:port`, as in a URL). */
  allowsHost: (host: string) => boolean
  /** The developer's own feed on this computer instead of GitHub. */
  local: boolean
  /** Where "see all releases" goes. */
  releasesUrl: string
}

export const GITHUB_FEED: ReleaseFeed = {
  url: `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
  origin: 'https://github.com',
  pagePrefix: `/${UPDATE_REPOSITORY}/`,
  downloadPrefix: `/${UPDATE_REPOSITORY}/releases/download/`,
  // GitHub serves release files from its own hosts, and has moved between them (objects, release-assets).
  allowsHost: (host) => host === 'github.com' || host.endsWith('.githubusercontent.com'),
  local: false,
  releasesUrl: `https://github.com/${UPDATE_REPOSITORY}/releases`
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * `CUBEX_UPDATE_FEED` points a development copy at a feed served from this computer, so the check, the download and
 * the notice can be tried without publishing a release. Only an `http:` or `https:` address on loopback is taken;
 * anything else leaves GitHub in place, so the variable cannot send an installed copy to another machine.
 */
export function resolveFeed(override: string | undefined): ReleaseFeed {
  if (!override || !override.trim()) return GITHUB_FEED
  try {
    const url = new URL(override.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return GITHUB_FEED
    return {
      url: url.href,
      origin: url.origin,
      pagePrefix: '/',
      downloadPrefix: '/',
      allowsHost: (host) => host === url.host,
      local: true,
      releasesUrl: url.origin
    }
  } catch {
    return GITHUB_FEED
  }
}
