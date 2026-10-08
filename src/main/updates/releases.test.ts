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

  it('takes a tag without the v, and a prerelease version in a final release', () => {
    expect(ok(release({ tag_name: '0.2.0' })).info.version).toBe('0.2.0')
    const beta = ok(release({ tag_name: 'v0.3.0-beta.1', html_url: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.3.0-beta.1' }, {
      name: 'Cubex-Setup-0.3.0-beta.1.exe',
      browser_download_url: 'https://github.com/HeshamXOR/Cubex/releases/download/v0.3.0-beta.1/Cubex-Setup-0.3.0-beta.1.exe'
    }))
    expect(beta.info.version).toBe('0.3.0-beta.1')
    expect(beta.installer?.name).toBe('Cubex-Setup-0.3.0-beta.1.exe')
  })

  it('refuses a draft or a prerelease, which the latest-release answer should never be', () => {
    expect(error(release({ draft: true }))).toMatch(/not a final one/)
    expect(error(release({ prerelease: true }))).toMatch(/not a final one/)
  })

  it('refuses a tag that is not a version, without printing a long one in full', () => {
    expect(error(release({ tag_name: 'nightly' }))).toMatch(/"nightly".*not a version number/)
    expect(error(release({ tag_name: 'x'.repeat(500) })).length).toBeLessThan(200)
    expect(error(release({ tag_name: undefined }))).toMatch(/not a version number/)
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

  it('accepts the repository in another letter case, as GitHub treats it', () => {
    expect(ok(release({ html_url: 'https://github.com/heshamxor/cubex/releases/tag/v0.2.0' })).info.pageUrl).toContain('/heshamxor/cubex/')
  })

  describe('the installer', () => {
    it('is the asset with the exact file name of this version, and nothing else', () => {
      const { info, installer } = ok(release({}, { name: 'Cubex-Setup-0.1.0.exe' }))
      expect(installer).toBeUndefined()
      expect(info.installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/no Windows installer/)
      expect(ok(release({}, null)).info.installerProblem).toMatch(/no Windows installer/)
    })

    it('is still reported, with its notes and page, when the installer is unusable', () => {
      const { info } = ok(release({}, { digest: null }))
      expect(info.version).toBe('0.2.0')
      expect(info.notes).toContain('Other agents')
      expect(info.installer).toBeUndefined()
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

    it('keeps the checksum in lowercase whatever case GitHub wrote it in', () => {
      expect(ok(release({}, { digest: `SHA256:${SHA.toUpperCase()}` })).installer?.sha256).toBe(SHA)
    })

    it.each([
      ['zero', 0], ['negative', -5], ['fractional', 1.5], ['past the limit', 500 * 1024 * 1024 + 1],
      ['text', '89484330'], ['unsafe', Number.MAX_SAFE_INTEGER + 2], ['missing', undefined]
    ])('is refused when its size is %s', (_name, size) => {
      const { installer, info } = ok(release({}, { size }))
      expect(installer).toBeUndefined()
      expect(info.installerProblem).toMatch(/size Cubex will not download/)
    })

    it('is accepted at the largest allowed size', () => {
      expect(ok(release({}, { size: 500 * 1024 * 1024 })).installer?.size).toBe(500 * 1024 * 1024)
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

    it('is ignored while GitHub is still receiving it', () => {
      expect(ok(release({}, { state: 'starter' })).installer).toBeUndefined()
      expect(ok(release({}, { state: undefined })).installer?.name).toBe('Cubex-Setup-0.2.0.exe')
    })

    it('is the first of two assets with the same name', () => {
      const json = release()
      ;(json.assets as unknown[]).push({ ...(json.assets as Record<string, unknown>[])[0], size: 5 })
      expect(ok(json).installer?.size).toBe(89_484_330)
    })
  })

  describe('the notes', () => {
    it('are plain text with ordinary line endings and no control characters', () => {
      const { info } = ok(release({ body: 'one\r\ntwo\rthree\u0000\u0007\u001b[31m red\u007f\n\tindented' }))
      expect(info.notes).toBe('one\ntwo\nthree[31m red\n\tindented')
    })

    it('are empty, not missing, when the release has none', () => {
      expect(ok(release({ body: undefined })).info.notes).toBe('')
      expect(ok(release({ body: 5 })).info.notes).toBe('')
      expect(ok(release({ body: '   \n ' })).info.notes).toBe('')
    })

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

    it('end at the marker whatever its spacing, case or line endings', () => {
      for (const marker of ['<!--end of notes-->', '  <!--   END OF NOTES   -->  ', '<!-- End Of Notes -->', '\t<!-- end of notes -->']) {
        expect(ok(release({ body: `kept\r\n${marker}\r\nleft out` })).info.notes).toBe('kept')
      }
    })

    it('keep a marker that shares its line with other text, since that is not the line that ends them', () => {
      const { notes } = ok(release({ body: `before ${UPDATE_NOTES_END} after` })).info
      expect(notes).toBe(`before ${UPDATE_NOTES_END} after`)
    })

    it('are empty when the marker comes first', () => {
      expect(ok(release({ body: `${UPDATE_NOTES_END}\nonly the page needs this` })).info.notes).toBe('')
    })

    it('are cut at the limit after the marker has ended them, not before', () => {
      const body = `${'a'.repeat(UPDATE_NOTES_LIMIT - 10)}\n${UPDATE_NOTES_END}\n${'b'.repeat(UPDATE_NOTES_LIMIT)}`
      const { info } = ok(release({ body }))
      expect(info.notes).toBe('a'.repeat(UPDATE_NOTES_LIMIT - 10))
      expect(info.notesCut).toBeUndefined()
    })

    it('are never cut through the middle of a character', () => {
      const body = `${'a'.repeat(UPDATE_NOTES_LIMIT - 1)}\u{1f600}more`
      const { notes } = ok(release({ body })).info
      expect(notes).toBe('a'.repeat(UPDATE_NOTES_LIMIT - 1))
    })
  })

  it('names a release that has no title after its version', () => {
    expect(ok(release({ name: '' })).info.name).toBe('Cubex 0.2.0')
    expect(ok(release({ name: undefined })).info.name).toBe('Cubex 0.2.0')
    expect(ok(release({ name: 'x'.repeat(900) })).info.name).toHaveLength(200)
  })

  it('leaves out a date it cannot read', () => {
    expect(ok(release({ published_at: 'yesterday-ish' })).info.publishedAt).toBeUndefined()
    expect(ok(release({ published_at: 20261020 })).info.publishedAt).toBeUndefined()
  })

  it.each([null, undefined, 'a string', 12, [], [{}]])('says it could not read %j', (json) => {
    expect(error(json)).toMatch(/could not read/)
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

  it('says what happened when GitHub cannot be reached', async () => {
    const result = await run(async () => { throw new TypeError('fetch failed') })
    expect(result).toEqual({ ok: false, error: 'Cubex could not reach GitHub. Check your connection and try again.' })
  })

  it('gives up on an answer that does not come', async () => {
    const result = await run((_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))), { timeoutMs: 20 })
    expect(result).toEqual({ ok: false, error: 'GitHub did not answer in time. Try again in a few minutes.' })
  })

  it('stops when it is told to', async () => {
    const controller = new AbortController()
    const pending = run((_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))), { signal: controller.signal, timeoutMs: 5_000 })
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'The check was cancelled.' })
  })

  it.each(['<html>Not JSON</html>', '', '{"tag_name":'])('does not guess at an answer that is not JSON (%j)', async (text) => {
    const result = await run(async () => new Response(text, { status: 200 }))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/could not read/) })
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

  it('reports a connection that broke while the answer was arriving', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('socket hang up')) } })
    const result = await run(async () => new Response(body, { status: 200 }))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/connection to GitHub broke/) })
  })
})
