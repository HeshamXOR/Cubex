import { UPDATE_MAX_BYTES, UPDATE_NOTES_LIMIT, type UpdateInfo } from '@shared/updates'
import { normalizeVersion } from '@shared/version'
import type { ReleaseFeed } from './feed'

/** The installer of a release, with the address and checksum that stay in the main process. */
export interface ReleaseInstaller {
  name: string
  url: string
  size: number
  /** Lowercase hex SHA-256, as GitHub computed it when the file was uploaded. */
  sha256: string
}

export interface ParsedRelease {
  info: UpdateInfo
  installer?: ReleaseInstaller
}

export type ReleaseResult = { ok: true; release: ParsedRelease } | { ok: false; error: string }

/** The reply of the releases API is a few kilobytes; this much is already far more than a release has. */
const MAX_REPLY_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const MAX_URL_LENGTH = 2048
const MAX_NAME_LENGTH = 200

const failure = (error: string): { ok: false; error: string } => ({ ok: false, error })

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Text from a release: line endings made plain, control characters dropped. */
function plain(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, '')
}

/** The line that ends the notes (`UPDATE_NOTES_END`), in whatever spacing and case a person typed it. */
const NOTES_END_LINE = /^[ \t]*<!--[ \t]*end of notes[ \t]*-->[ \t]*$/im

/** The notes as shown: cleaned, ended at their marker when they have one, and cut at the limit without splitting a character in two. */
function cleanNotes(value: unknown): { notes: string; cut: boolean } {
  const whole = typeof value === 'string' ? plain(value) : ''
  const marker = NOTES_END_LINE.exec(whole)
  const text = (marker ? whole.slice(0, marker.index) : whole).trim()
  if (text.length <= UPDATE_NOTES_LIMIT) return { notes: text, cut: false }
  let end = UPDATE_NOTES_LIMIT
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { notes: text.slice(0, end).trimEnd(), cut: true }
}

/**
 * An address from a release, if it is a plain `https:` address (or the feed's own, for the developer feed) on the
 * feed's origin and under its path. Parsed rather than matched as text, so `..` segments, userinfo and look-alike
 * hosts such as `github.com.evil.example` do not pass.
 */
function checkedUrl(value: unknown, feed: ReleaseFeed, prefix: string): URL | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.origin !== feed.origin || url.username || url.password) return undefined
  if (!url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) return undefined
  return url
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

const NO_INSTALLER = 'This release has no Windows installer yet.'
const NO_CHECKSUM = 'This release has no checksum, so Cubex will not install it for you. Download it from the release page.'
const BAD_SIZE = 'The installer of this release has a size Cubex will not download. Get it from the release page.'
const BAD_ADDRESS = 'The installer of this release is not on GitHub under the Cubex repository, so Cubex will not download it.'

/** Which asset of the release is the installer, and whether it can be trusted enough to install. */
function chooseInstaller(assets: unknown, version: string, feed: ReleaseFeed): { installer?: ReleaseInstaller; problem?: string } {
  const name = `Cubex-Setup-${version}.exe`
  const asset = (Array.isArray(assets) ? assets : []).map(asRecord).find((candidate) => candidate?.name === name && (candidate.state === undefined || candidate.state === 'uploaded'))
  if (!asset) return { problem: NO_INSTALLER }

  const url = checkedUrl(asset.browser_download_url, feed, feed.downloadPrefix)
  if (!url || url.search || url.hash) return { problem: BAD_ADDRESS }
  let last: string
  try { last = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)) } catch { return { problem: BAD_ADDRESS } }
  if (last !== name) return { problem: BAD_ADDRESS }

  const size = asset.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > UPDATE_MAX_BYTES) return { problem: BAD_SIZE }

  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null
  if (!digest) return { problem: NO_CHECKSUM }
  return { installer: { name, url: url.href, size, sha256: digest[1]!.toLowerCase() } }
}

/**
 * One release of the releases API, reduced to what the window may show and what the main process needs to fetch it.
 * The release is untrusted: its version must be a version, its addresses must be the repository's, and an installer
 * counts only with the exact file name, a bounded size and a checksum.
 */
export function parseRelease(json: unknown, feed: ReleaseFeed): ReleaseResult {
  const release = asRecord(json)
  if (!release) return failure('GitHub sent an answer Cubex could not read. Try again later.')
  if (release.draft === true || release.prerelease === true) return failure('The newest release is not a final one yet.')

  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = normalizeVersion(tag)
  if (!version) return failure(`The newest release is tagged "${plain(tag).slice(0, 40)}", which is not a version number, so Cubex cannot compare it.`)

  const page = checkedUrl(release.html_url, feed, feed.pagePrefix)
  if (!page) return failure('The newest release points to a page outside the Cubex repository, so Cubex ignored it.')

  const name = typeof release.name === 'string' ? plain(release.name).trim().slice(0, MAX_NAME_LENGTH) : ''
  const { notes, cut } = cleanNotes(release.body)
  const { installer, problem } = chooseInstaller(release.assets, version, feed)
  const publishedAt = isoDate(release.published_at)
  return {
    ok: true,
    release: {
      info: {
        version,
        name: name || `Cubex ${version}`,
        notes,
        ...(cut ? { notesCut: true } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        pageUrl: page.href,
        ...(installer ? { installer: { name: installer.name, size: installer.size } } : { installerProblem: problem ?? NO_INSTALLER })
      },
      ...(installer ? { installer } : {})
    }
  }
}

/** The body of a response as text, or undefined when it is longer than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

export interface FetchReleaseOptions {
  fetch: typeof fetch
  feed: ReleaseFeed
  userAgent: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** Asks for the latest release. Every failure is a sentence that says what happened and what to do; nothing throws. */
export async function fetchLatestRelease(options: FetchReleaseOptions): Promise<ReleaseResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await options.fetch(options.feed.url, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': options.userAgent },
      signal
    })
  } catch {
    if (options.signal?.aborted) return failure('The check was cancelled.')
    if (timeout.aborted) return failure('GitHub did not answer in time. Try again in a few minutes.')
    return failure('Cubex could not reach GitHub. Check your connection and try again.')
  }

  try {
    // A repository that moved answers from another address; only the feed's own host is believed.
    if (response.url && new URL(response.url).origin !== new URL(options.feed.url).origin) {
      await response.body?.cancel().catch(() => undefined)
      return failure('GitHub sent Cubex somewhere else, so it ignored the answer. Try again later.')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      const limited = (response.status === 403 || response.status === 429) && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
      if (limited) return failure('GitHub is limiting requests from this network. Try again in an hour.')
      if (response.status === 404) return failure('GitHub has no published release to compare with yet.')
      return failure(`GitHub answered with an error (${response.status}). Try again later.`)
    }
    const text = await readCapped(response, MAX_REPLY_BYTES)
    if (text === undefined) return failure('GitHub sent far more data than a release has, so Cubex ignored it. Try again later.')
    let json: unknown
    try { json = JSON.parse(text) } catch { return failure('GitHub sent an answer Cubex could not read. Try again later.') }
    return parseRelease(json, options.feed)
  } catch {
    if (options.signal?.aborted) return failure('The check was cancelled.')
    if (timeout.aborted) return failure('GitHub did not answer in time. Try again in a few minutes.')
    return failure('The connection to GitHub broke before the answer arrived. Try again.')
  }
}
