import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveFeed } from '../src/main/updates/feed'
import { fetchLatestRelease } from '../src/main/updates/releases'
import { startFeed } from './dev-update-feed.mjs'

const open = []
afterEach(async () => {
  for (const feed of open.splice(0)) await feed.close()
})

async function start(options) {
  const feed = await startFeed({ sizeMb: 0.25, ...options })
  open.push(feed)
  return feed
}

const ask = (feed) => fetchLatestRelease({ fetch, feed: resolveFeed(feed.url), userAgent: 'Cubex/test' })

describe('the feed on this computer', () => {
  it('is a loopback address, which is the only kind Cubex takes for CUBEX_UPDATE_FEED', async () => {
    const feed = await start()
    expect(feed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/latest$/)
    expect(resolveFeed(feed.url).local).toBe(true)
  })

  it('is read by the updater as a release with an installer it can verify', async () => {
    const feed = await start({ version: '3.4.5' })
    const result = await ask(feed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { info, installer } = result.release
    expect(info.version).toBe('3.4.5')
    expect(info.installer).toEqual({ name: 'Cubex-Setup-3.4.5.exe', size: 256 * 1024 })
    expect(installer?.sha256).toBe(feed.installer.sha256)
    expect(info.pageUrl).toBe(feed.url.replace('/latest', '/release/v3.4.5'))
  })

  it('shows the notes and leaves out what is after the marker', async () => {
    const feed = await start({ notes: '### New\n\n- A thing.' })
    const result = await ask(feed)
    expect(result.ok && result.release.info.notes).toBe('### New\n\n- A thing.')
  })

  it('serves the bytes it advertises', async () => {
    const feed = await start()
    const result = await ask(feed)
    if (!result.ok || !result.release.installer) throw new Error('no installer')
    const response = await fetch(result.release.installer.url)
    expect(response.status).toBe(200)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBe(result.release.installer.size)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.release.installer.sha256)
  })

  it('serves the same bytes every time, so a download can be resumed', async () => {
    const feed = await start()
    const result = await ask(feed)
    if (!result.ok || !result.release.installer) throw new Error('no installer')
    const whole = Buffer.from(await (await fetch(result.release.installer.url)).arrayBuffer())
    const rest = await fetch(result.release.installer.url, { headers: { Range: 'bytes=1000-' } })
    expect(rest.status).toBe(206)
    expect(rest.headers.get('content-range')).toBe(`bytes 1000-${whole.length - 1}/${whole.length}`)
    expect(Buffer.from(await rest.arrayBuffer()).equals(whole.subarray(1000))).toBe(true)
  })

  it('can advertise a checksum the file does not have', async () => {
    const feed = await start({ badChecksum: true })
    const result = await ask(feed)
    if (!result.ok || !result.release.installer) throw new Error('no installer')
    expect(result.release.installer.sha256).toBe('0'.repeat(64))
    expect(result.release.installer.sha256).not.toBe(feed.installer.sha256)
  })

  it('can offer a release with no installer', async () => {
    const feed = await start({ noInstaller: true })
    const result = await ask(feed)
    expect(result.ok && result.release.installer).toBeFalsy()
    expect(result.ok && result.release.info.installerProblem).toMatch(/no Windows installer/)
  })

  it('answers a page of its own for the release, and nothing else', async () => {
    const feed = await start()
    expect((await fetch(feed.url.replace('/latest', '/release/v99.0.0'))).status).toBe(200)
    expect((await fetch(feed.url.replace('/latest', '/anything'))).status).toBe(404)
  })

  it('lists what was asked of it', async () => {
    const feed = await start()
    await ask(feed)
    await fetch(feed.url.replace('/latest', '/nothing-here'))
    expect(feed.requests).toEqual(['GET /latest', 'GET /nothing-here'])
  })

  it('can be slowed, to watch a download', async () => {
    const feed = await start({ sizeMb: 0.05, rateKb: 100 })
    const result = await ask(feed)
    if (!result.ok || !result.release.installer) throw new Error('no installer')
    const started = Date.now()
    const bytes = Buffer.from(await (await fetch(result.release.installer.url)).arrayBuffer())
    expect(bytes.length).toBe(result.release.installer.size)
    // 51 KB at 100 KB a second, in tenths of a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })
})
