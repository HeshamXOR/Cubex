import { describe, expect, it } from 'vitest'
import { UPDATE_NOTES_END, UPDATE_NOTES_LIMIT } from '@shared/updates'
import { GITHUB_FEED, resolveFeed } from './feed'
import { fetchLatestRelease, parseRelease } from './releases'

const SHA = 'b09a7f88c278b3ad4b4628f055127b05698766b4fe3762820f2cb7bd220582bb'

/** A release as GitHub's API answers it, with the fields the updater reads. */
function release(overrides: Record<string, unknown> = {}, asset: Record<string, unknown> | null = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    name: 'Cubex 0.2.0',
    body: '## What is new\n\n- Other agents\n- Settings pages',
    draft: false,
    prerelease: false,
    published_at: '2026-10-20T09:30:00Z',
    html_url: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
    assets: asset === null ? [] : [{
      name: 'Cubex-Setup-0.2.0.exe',
      size: 89_484_330,
      state: 'uploaded',
      content_type: 'application/octet-stream',
      digest: `sha256:${SHA}`,
      browser_download_url: 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe',
      ...asset
    }],
    ...overrides
  }
}

const parsed = (json: unknown, feed = GITHUB_FEED): ReturnType<typeof parseRelease> => parseRelease(json, feed)

function ok(json: unknown, feed = GITHUB_FEED): NonNullable<Extract<ReturnType<typeof parseRelease>, { ok: true }>['release']> {
  const result = parsed(json, feed)
  if (!result.ok) throw new Error(`expected a release, got: ${result.error}`)
  return result.release
}

function error(json: unknown, feed = GITHUB_FEED): string {
  const result = parsed(json, feed)
  if (result.ok) throw new Error('expected a refusal')
  return result.error
}

describe('parseRelease', () => {
  it('reduces a release to what the window shows and keeps the installer details apart', () => {
    const { info, installer } = ok(release())
    expect(info).toEqual({
      version: '0.2.0',
      name: 'Cubex 0.2.0',
      notes: '## What is new\n\n- Other agents\n- Settings pages',
      publishedAt: '2026-10-20T09:30:00.000Z',
      pageUrl: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
      installer: { name: 'Cubex-Setup-0.2.0.exe', size: 89_484_330 }
    })
    expect(installer).toEqual({
      name: 'Cubex-Setup-0.2.0.exe',
      size: 89_484_330,
      url: 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe',
      sha256: SHA
    })
    // The window never gets the download address or the checksum.
    expect(JSON.stringify(info)).not.toContain('releases/download')
    expect(JSON.stringify(info)).not.toContain(SHA)
  })

  it('refuses a draft or a prerelease, which the latest-release answer should never be', () => {
    expect(error(release({ draft: true }))).toMatch(/not a final one/)
    expect(error(release({ prerelease: true }))).toMatch(/not a final one/)
  })

  it.each([
    ['another host', 'https://github.com.evil.example/HeshamXOR/Cubex/releases/tag/v0.2.0'],
    ['plain http', 'http://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0'],
    ['another repository', 'https://github.com/Someone/Cubex/releases/tag/v0.2.0'],
    ['a path that climbs out', 'https://github.com/HeshamXOR/Cubex/../Other/releases/tag/v0.2.0'],
    ['a name and password', 'https://HeshamXOR:x@github.com/HeshamXOR/Cubex/releases/tag/v0.2.0'],
    ['a relative address', '/HeshamXOR/Cubex/releases/tag/v0.2.0'],
    ['a script', 'javascript:alert(1)'],
    ['nothing', undefined]
  ])('refuses a release page on %s', (_name, html_url) => {
    expect(error(release({ html_url }))).toMatch(/outside the Cubex repository/)
  })

  describe('the installer', () => {
    it('is the asset with the exact file name of this version, and nothing else', () => {
      const { info, installer } = ok(release({}, { name: 'Cubex-Setup-0.1.0.exe' }))
      expect(installer).toBeUndefined()
      expect(info.installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/no Windows installer/)
      expect(ok(release({}, null)).info.installerProblem).toMatch(/no Windows installer/)
    })

    it.each([
      ['no checksum', { digest: undefined }],
      ['a checksum of another kind', { digest: `sha1:${SHA.slice(0, 40)}` }],
      ['a checksum that is not hex', { digest: `sha256:${'z'.repeat(64)}` }],
      ['a checksum of the wrong length', { digest: `sha256:${SHA.slice(0, 63)}` }],
      ['a checksum that is not text', { digest: 12 }]
    ])('is not installed by Cubex with %s', (_name, asset) => {
      const { installer, info } = ok(release({}, asset))
      expect(installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/no checksum/)
    })

    it.each([
      ['zero', 0], ['negative', -5], ['fractional', 1.5], ['past the limit', 500 * 1024 * 1024 + 1],
      ['text', '89484330'], ['unsafe', Number.MAX_SAFE_INTEGER + 2], ['missing', undefined]
    ])('is refused when its size is %s', (_name, size) => {
      const { installer, info } = ok(release({}, { size }))
      expect(installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/size Cubex will not download/)
    })

    it.each([
      ['another host', 'https://evil.example/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'],
      ['a look-alike host', 'https://github.com.evil.example/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'],
      ['plain http', 'http://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'],
      ['another repository', 'https://github.com/Someone/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'],
      ['the repository but not a release download', 'https://github.com/HeshamXOR/Cubex/raw/main/Cubex-Setup-0.2.0.exe'],
      ['a query', 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe?x=1'],
      ['a fragment', 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe#x'],
      ['another file name', 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Other.exe'],
      ['an encoded other name', 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe%2F..%2FOther.exe'],
      ['a path that climbs out', 'https://github.com/HeshamXOR/Cubex/releases/download/../../../Other/x/Cubex-Setup-0.2.0.exe'],
      ['not text', 42]
    ])('is refused when its address is %s', (_name, browser_download_url) => {
      const { installer, info } = ok(release({}, { browser_download_url }))
      expect(installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/not on GitHub under the Cubex repository/)
    })
  })

  describe('the notes', () => {

    it('are cut at the limit, and the cut is said', () => {
      const long = ok(release({ body: 'a'.repeat(UPDATE_NOTES_LIMIT + 500) })).info
      expect(long.notes).toHaveLength(UPDATE_NOTES_LIMIT)
      expect(long.notesCut).toBe(true)
      const exact = ok(release({ body: 'b'.repeat(UPDATE_NOTES_LIMIT) })).info
      expect(exact.notesCut).toBeUndefined()
    })

    it('end at the marker the release workflow writes, and what follows is for the release page', () => {
      const body = `## New\n\n- Other agents\n\n${UPDATE_NOTES_END}\n\n## Download\n\n| File | Platform |\n|---|---|\n| Cubex-Setup-0.2.0.exe | Windows |`
      const { info } = ok(release({ body }))
      expect(info.notes).toBe('## New\n\n- Other agents')
      expect(info.notesCut).toBeUndefined()
      expect(info.notes).not.toContain('Download')
    })
  })

  describe('on a feed served from this computer', () => {
    const feed = resolveFeed('http://127.0.0.1:5050/latest.json')
    const local = (): Record<string, unknown> => release({ html_url: 'http://127.0.0.1:5050/releases/v0.2.0' }, {
      browser_download_url: 'http://127.0.0.1:5050/files/Cubex-Setup-0.2.0.exe'
    })

    it('takes the pages and installers of that server', () => {
      const { info, installer } = ok(local(), feed)
      expect(info.pageUrl).toBe('http://127.0.0.1:5050/releases/v0.2.0')
      expect(installer?.url).toBe('http://127.0.0.1:5050/files/Cubex-Setup-0.2.0.exe')
    })

    it('does not take GitHub addresses, which are not its own', () => {
      expect(error(release(), feed)).toMatch(/outside the Cubex repository/)
    })
  })
})

describe('fetchLatestRelease', () => {
  const userAgent = 'Cubex/0.1.0'
  const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  const run = (fetchImpl: typeof fetch, extra: { signal?: AbortSignal; timeoutMs?: number } = {}): ReturnType<typeof fetchLatestRelease> =>
    fetchLatestRelease({ fetch: fetchImpl, feed: GITHUB_FEED, userAgent, ...extra })

  it('asks the releases API the way GitHub documents, and parses the answer', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await run(async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> })
      return json(release())
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{
      url: 'https://api.github.com/repos/HeshamXOR/Cubex/releases/latest',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Cubex/0.1.0' }
    }])
  })

  it('sends nothing that identifies the person: no cookie, no token, no body', async () => {
    let init: RequestInit | undefined
    await run(async (_input, received) => { init = received; return json(release()) })
    expect(Object.keys(init?.headers as Record<string, string>).map((name) => name.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version'])
    expect(init?.body).toBeUndefined()
    expect(init?.method).toBeUndefined()
  })

  it.each([
    [404, {}, /no published release/],
    [403, { 'x-ratelimit-remaining': '0' }, /limiting requests/],
    [429, { 'retry-after': '3600' }, /limiting requests/],
    [403, {}, /error \(403\)/],
    [500, {}, /error \(500\)/],
    [503, { 'retry-after': '30' }, /error \(503\)/]
  ])('explains an answer of %i', async (status, headers, message) => {
    const result = await run(async () => new Response('{}', { status, headers }))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(message) })
  })

  it('ignores an answer larger than any release, whether it says so or not', async () => {
    const declared = await run(async () => new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }))
    expect(declared).toEqual({ ok: false, error: expect.stringMatching(/far more data/) })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)) }
    })
    const streamed = await run(async () => new Response(body, { status: 200 }))
    expect(streamed).toEqual({ ok: false, error: expect.stringMatching(/far more data/) })
  })

  it('does not believe an answer that came from another site after a redirect', async () => {
    const response = json(release())
    Object.defineProperty(response, 'url', { value: 'https://evil.example/repos/HeshamXOR/Cubex/releases/latest' })
    expect(await run(async () => response)).toEqual({ ok: false, error: expect.stringMatching(/somewhere else/) })
    const same = json(release())
    Object.defineProperty(same, 'url', { value: 'https://api.github.com/repositories/123/releases/latest' })
    expect((await run(async () => same)).ok).toBe(true)
  })
})
