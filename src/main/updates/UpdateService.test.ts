import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateBusy, UpdateState } from '@shared/updates'
import { GITHUB_FEED } from './feed'
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, LOCAL_ONLY_DOWNLOAD_MESSAGE, LOCAL_ONLY_MESSAGE, UpdateService, type UpdateServiceOptions } from './UpdateService'

// --- The world the service talks to ------------------------------------------------------------

const INSTALLER = Buffer.from(Array.from({ length: 300_000 }, (_, index) => (index * 31 + 7) & 255))
const SHA = createHash('sha256').update(INSTALLER).digest('hex')
const PAGE = 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0'
const ASSET = 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=1'

function releaseJson(version = '0.2.0', asset: Record<string, unknown> | null = {}): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    name: `Cubex ${version}`,
    body: `## Cubex ${version}\n\n- A new thing`,
    draft: false,
    prerelease: false,
    published_at: '2026-10-20T09:30:00Z',
    html_url: `https://github.com/HeshamXOR/Cubex/releases/tag/v${version}`,
    assets: asset === null ? [] : [{
      name: `Cubex-Setup-${version}.exe`,
      size: INSTALLER.length,
      state: 'uploaded',
      digest: `sha256:${SHA}`,
      browser_download_url: `https://github.com/HeshamXOR/Cubex/releases/download/v${version}/Cubex-Setup-${version}.exe`,
      ...asset
    }]
  }
}

/** The bytes of the installer as a stream of 64 KB pieces. `hold` stops after the first piece until the request is aborted. */
function installerResponse(init: RequestInit | undefined, bytes: Buffer, options: { hold?: boolean; cutAt?: number } = {}): Response {
  const range = /^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('range') ?? '')
  const start = range ? Number(range[1]) : 0
  const end = options.cutAt !== undefined ? Math.min(options.cutAt, bytes.length) : bytes.length
  const slice = bytes.subarray(start, end)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.hold) init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted')))
    },
    pull(controller) {
      if (options.hold && offset > 0) return new Promise<void>(() => undefined)
      if (offset >= slice.length) { controller.close(); return undefined }
      controller.enqueue(new Uint8Array(slice.subarray(offset, offset + 65_536)))
      offset += 65_536
      return undefined
    }
  })
  return range
    ? new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } })
    : new Response(body, { status: 200 })
}

interface World {
  calls: string[]
  release: () => Response | Promise<Response>
  installer: (init: RequestInit | undefined) => Response
  busy: UpdateBusy
  startFails: boolean
}

function newWorld(): World {
  return {
    calls: [],
    release: () => new Response(JSON.stringify(releaseJson()), { status: 200 }),
    installer: (init) => installerResponse(init, INSTALLER),
    busy: { turns: 0, tasks: 0 },
    startFails: false
  }
}

function fakeFetch(world: World): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    world.calls.push(`${init?.redirect ?? 'follow'} ${url}`)
    if (url === GITHUB_FEED.url) return world.release()
    if (url === ASSET) return new Response(null, { status: 302, headers: { location: CDN } })
    if (url === CDN) return world.installer(init)
    throw new TypeError('fetch failed')
  }
}

// --- A service wired to it ----------------------------------------------------------------------

let directory: string
let world: World
let clock: { now: number }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cubex-update-test-'))
  world = newWorld()
  clock = { now: Date.parse('2026-10-21T10:00:00Z') }
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

interface Harness {
  service: UpdateService
  pushed: UpdateState[]
  events: string[]
  settings: { auto: boolean; skippedVersion: string | undefined; localOnly: boolean }
  folder: string
}

function harness(overrides: Partial<UpdateServiceOptions> = {}): Harness {
  const pushed: UpdateState[] = []
  const events: string[] = []
  const settings = { auto: true, skippedVersion: undefined as string | undefined, localOnly: false }
  const folder = join(directory, 'updates')
  const service = new UpdateService({
    currentVersion: '0.1.0',
    support: { canInstall: true },
    feed: GITHUB_FEED,
    fetch: fakeFetch(world),
    userAgent: 'Cubex/0.1.0',
    directory: folder,
    automatic: true,
    settings: () => ({ ...settings }),
    saveSkippedVersion: (version) => { settings.skippedVersion = version || undefined; events.push(`skip ${version}`) },
    push: (state) => { pushed.push(state) },
    busy: () => world.busy,
    startInstaller: async (path) => {
      events.push(`start ${path}`)
      if (world.startFails) throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })
    },
    quit: () => { events.push('quit') },
    openExternal: async (url) => { events.push(`open ${url}`) },
    now: () => clock.now,
    download: { retryDelayMs: () => 0, stallTimeoutMs: 5_000, reserveBytes: 0 },
    ...overrides
  })
  return { service, pushed, events, settings, folder }
}

/** A service that has found the update and downloaded it. */
async function readyService(overrides: Partial<UpdateServiceOptions> = {}): Promise<Harness> {
  const h = harness(overrides)
  await h.service.checkNow(true)
  await h.service.download()
  expect(h.service.getState().update?.stage).toBe('ready')
  return h
}

const stage = (h: Harness): string | undefined => h.service.getState().update?.stage

// --- Looking -----------------------------------------------------------------------------------

describe('the state before anything happened', () => {
  it('is idle, and says whether this copy can replace itself', () => {
    expect(harness().service.getState()).toEqual({ currentVersion: '0.1.0', canInstall: true, check: { status: 'idle' } })
    const portable = harness({ support: { canInstall: false, reason: 'This copy was not set up with the Cubex installer, so it cannot update itself.' } }).service.getState()
    expect(portable.canInstall).toBe(false)
    expect(portable.cannotInstallReason).toMatch(/not set up with the Cubex installer/)
  })
})

describe('checking', () => {
  it('finds a newer release and offers it', async () => {
    const h = harness()
    const state = await h.service.checkNow(true)
    expect(state.check).toEqual({ status: 'done', at: clock.now })
    expect(state.update).toMatchObject({
      stage: 'available',
      info: { version: '0.2.0', name: 'Cubex 0.2.0', pageUrl: PAGE, installer: { name: 'Cubex-Setup-0.2.0.exe', size: INSTALLER.length } }
    })
    expect(state.update?.skipped).toBeUndefined()
    // The window is told as it happens: a look has begun, then what it found.
    expect(h.pushed.map((entry) => entry.check.status)).toEqual(['checking', 'done'])
    expect(h.pushed.at(-1)).toEqual(state)
  })

  it('never hands the window the download address or the checksum', async () => {
    const h = harness()
    await h.service.checkNow(true)
    const everything = JSON.stringify(h.pushed)
    expect(everything).not.toContain('releases/download')
    expect(everything).not.toContain(SHA)
  })

  it.each(['0.1.0', '0.0.9', '0.1.0-beta.1'])('offers nothing when the newest release is %s and this is 0.1.0', async (version) => {
    world.release = () => new Response(JSON.stringify(releaseJson(version)), { status: 200 })
    const h = harness()
    const state = await h.service.checkNow(true)
    expect(state.update).toBeUndefined()
    expect(state.check.status).toBe('done')
  })

  it('offers a final release over the prerelease of the same number', async () => {
    const h = harness({ currentVersion: '0.2.0-beta.1' })
    expect((await h.service.checkNow(true)).update?.info.version).toBe('0.2.0')
  })

  it('drops an offer when the release is no longer newer, as when it was withdrawn', async () => {
    const h = harness()
    await h.service.checkNow(true)
    world.release = () => new Response(JSON.stringify(releaseJson('0.1.0')), { status: 200 })
    expect((await h.service.checkNow(true)).update).toBeUndefined()
  })

  it('keeps what it knew when a later look fails, and says what happened', async () => {
    const h = harness()
    await h.service.checkNow(true)
    const found = clock.now
    clock.now += 60_000
    world.release = () => { throw new TypeError('fetch failed') }
    const state = await h.service.checkNow(false)
    expect(state.check).toEqual({ status: 'failed', at: found, error: 'Cubex could not reach GitHub. Check your connection and try again.' })
    expect(state.update?.stage).toBe('available')
  })

  it('explains a failure of the very first look', async () => {
    world.release = () => new Response('', { status: 500 })
    const h = harness()
    const state = await h.service.checkNow(true)
    expect(state.check).toEqual({ status: 'failed', error: 'GitHub answered with an error (500). Try again later.' })
    expect(state.update).toBeUndefined()
  })

  it('does not ask GitHub twice at once', async () => {
    const h = harness()
    const first = h.service.checkNow(true)
    const second = h.service.checkNow(true)
    expect(await second).toEqual(await first)
    expect(world.calls.filter((call) => call.endsWith(GITHUB_FEED.url))).toHaveLength(1)
  })

  it('stays out of the way of a download', async () => {
    const h = harness()
    await h.service.checkNow(true)
    world.installer = (init) => installerResponse(init, INSTALLER, { hold: true })
    const downloading = h.service.download()
    const before = world.calls.length
    const state = await h.service.checkNow(true)
    expect(state.update?.stage).toBe('downloading')
    expect(world.calls.slice(before).some((call) => call.endsWith(GITHUB_FEED.url))).toBe(false)
    await h.service.cancelDownload()
    await downloading
  })

  it('keeps its word when the window that listens is gone', async () => {
    const h = harness({ push: () => { throw new Error('Object has been destroyed') } })
    expect((await h.service.checkNow(true)).update?.stage).toBe('available')
  })
})

describe('local-only mode', () => {
  it('blocks a check the person asks for, and says how to allow it', async () => {
    const h = harness()
    h.settings.localOnly = true
    const state = await h.service.checkNow(true)
    expect(state.check).toEqual({ status: 'failed', error: LOCAL_ONLY_MESSAGE })
    expect(LOCAL_ONLY_MESSAGE).toBe('Local-only mode blocks update checks. Turn it off in Privacy to check.')
    expect(world.calls).toEqual([])
  })

  it('does not even look when nobody asked', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.localOnly = true
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1000)
    expect(world.calls).toEqual([])
    expect(h.pushed).toEqual([])
  })

  it('does not download an update that was found before the mode was turned on, and says how to allow it', async () => {
    const h = harness()
    await h.service.checkNow(true)
    h.settings.localOnly = true
    const before = world.calls.length
    const state = await h.service.download()
    expect(state.update).toMatchObject({ stage: 'available', error: LOCAL_ONLY_DOWNLOAD_MESSAGE })
    expect(LOCAL_ONLY_DOWNLOAD_MESSAGE).toBe('Local-only mode blocks the download. Turn it off in Privacy to download the update.')
    expect(world.calls).toHaveLength(before)
    // Turned off again, the same update downloads.
    h.settings.localOnly = false
    expect((await h.service.download()).update?.stage).toBe('ready')
  })

  it('still installs an update that was downloaded before, since nothing leaves the computer', async () => {
    const h = await readyService()
    h.settings.localOnly = true
    expect(await h.service.install()).toEqual({ ok: true })
  })
})

describe('skipping', () => {
  it('is remembered, and the release stays known but not announced', async () => {
    const h = harness()
    await h.service.checkNow(true)
    const state = h.service.skip('0.2.0')
    expect(h.events).toEqual(['skip 0.2.0'])
    expect(state.update).toMatchObject({ stage: 'available', skipped: true })
  })

  it('keeps an automatic look quiet about the skipped version', async () => {
    const h = harness()
    h.settings.skippedVersion = '0.2.0'
    const state = await h.service.checkNow(false)
    expect(state.update).toMatchObject({ stage: 'available', skipped: true })
  })

  it('announces a version newer than the skipped one', async () => {
    const h = harness()
    h.settings.skippedVersion = '0.2.0'
    world.release = () => new Response(JSON.stringify(releaseJson('0.3.0')), { status: 200 })
    const state = await h.service.checkNow(false)
    expect(state.update?.info.version).toBe('0.3.0')
    expect(state.update?.skipped).toBeUndefined()
  })

  it('lets the person look again: asking by hand forgets the skip', async () => {
    const h = harness()
    h.settings.skippedVersion = '0.2.0'
    const state = await h.service.checkNow(true)
    expect(state.update?.skipped).toBeUndefined()
    expect(h.events).toEqual(['skip '])
    expect(h.settings.skippedVersion).toBeUndefined()
  })

  it('ignores a version that is not the one on offer', async () => {
    const h = harness()
    await h.service.checkNow(true)
    expect(h.service.skip('0.9.9').update?.skipped).toBeUndefined()
    expect(h.service.skip('latest').update?.skipped).toBeUndefined()
    expect(h.events).toEqual([])
  })

  it('does nothing without an update', () => {
    const h = harness()
    expect(h.service.skip('0.2.0').update).toBeUndefined()
    expect(h.events).toEqual([])
  })

  it('takes the version in the form a tag has it', async () => {
    const h = harness()
    await h.service.checkNow(true)
    h.service.skip('v0.2.0')
    expect(h.events).toEqual(['skip 0.2.0'])
  })
})

// --- On its own ---------------------------------------------------------------------------------

describe('checking on its own', () => {
  const lookups = (): number => world.calls.filter((call) => call.endsWith(GITHUB_FEED.url)).length

  it('looks 20 seconds after it starts, and then every six hours', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(lookups()).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(lookups()).toBe(1)
    expect(FIRST_CHECK_DELAY_MS).toBe(20_000)
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1000)
    expect(lookups()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(lookups()).toBe(2)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(lookups()).toBe(3)
  })

  it('starts once however often it is told to', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    h.service.start()
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1)
    expect(lookups()).toBe(1)
  })

  it('does not try again soon after a failure, it waits for its time', async () => {
    vi.useFakeTimers()
    world.release = () => new Response('', { status: 503 })
    const h = harness()
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1)
    expect(lookups()).toBe(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 60_000)
    expect(lookups()).toBe(1)
    expect(h.service.getState().check.status).toBe('failed')
  })

  it('reads the setting each time, so switching it off takes effect without a restart', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1)
    expect(lookups()).toBe(1)
    h.settings.auto = false
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(lookups()).toBe(1)
    h.settings.auto = true
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(lookups()).toBe(2)
  })

  it('does not look by itself in a copy run from source', async () => {
    vi.useFakeTimers()
    const h = harness({ automatic: false })
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 2)
    expect(lookups()).toBe(0)
    // Asking by hand still works there.
    expect((await h.service.checkNow(true)).update?.stage).toBe('available')
  })

  it('stops when it is disposed', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    h.service.dispose()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(lookups()).toBe(0)
    expect(h.pushed).toEqual([])
  })

  it('can be set going again after it found something, without losing it', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1)
    expect(h.service.getState().update?.stage).toBe('available')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(h.service.getState().update?.stage).toBe('available')
  })
})

// --- Tidying ------------------------------------------------------------------------------------

describe('installers that have done their work', () => {
  const left = async (folder: string): Promise<string[]> => (await readdir(folder)).sort()

  it('are deleted when it starts: the version that is running and older ones, with their partial files', async () => {
    const h = harness({ currentVersion: '0.2.0' })
    await mkdir(h.folder, { recursive: true })
    const names = ['Cubex-Setup-0.1.0.exe', 'Cubex-Setup-0.2.0.exe', 'Cubex-Setup-0.1.9.exe.part', 'Cubex-Setup-0.1.9.exe.part.json', 'Cubex-Setup-0.2.0-beta.1.exe']
    for (const name of names) await writeFile(join(h.folder, name), 'x')
    h.service.start()
    await vi.waitFor(async () => expect(await left(h.folder)).toEqual([]))
    h.service.dispose()
  })

  it('are kept when they are newer: that is a download waiting for its restart', async () => {
    const h = harness({ currentVersion: '0.2.0' })
    await mkdir(h.folder, { recursive: true })
    for (const name of ['Cubex-Setup-0.2.1.exe', 'Cubex-Setup-0.3.0.exe.part', 'Cubex-Setup-0.3.0.exe.part.json', 'Cubex-Setup-0.1.0.exe']) await writeFile(join(h.folder, name), 'x')
    h.service.start()
    await vi.waitFor(async () => expect(await left(h.folder)).toEqual(['Cubex-Setup-0.2.1.exe', 'Cubex-Setup-0.3.0.exe.part', 'Cubex-Setup-0.3.0.exe.part.json']))
    h.service.dispose()
  })

  it('leave every other file alone, including one that only looks like an installer', async () => {
    const h = harness({ currentVersion: '0.2.0' })
    await mkdir(h.folder, { recursive: true })
    const others = ['notes.txt', 'Cubex-Setup.exe', 'Cubex-Setup-0.1.0.zip', 'Cubex-Setup-banana.exe', 'cubex-setup-0.1.0.exe.bak']
    for (const name of [...others, 'Cubex-Setup-0.1.0.exe']) await writeFile(join(h.folder, name), 'x')
    h.service.start()
    await vi.waitFor(async () => expect(await left(h.folder)).toEqual([...others].sort()))
    h.service.dispose()
  })

  it('need no folder: a copy that never downloaded anything has none', async () => {
    const h = harness({ currentVersion: '0.2.0' })
    expect(() => h.service.start()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.service.dispose()
  })
})

// --- Downloading --------------------------------------------------------------------------------

describe('downloading', () => {
  it('fetches the installer through GitHub\'s redirect, checks it, and keeps it under its own name', async () => {
    const h = harness()
    await h.service.checkNow(true)
    const finished = await h.service.download()
    expect(finished.update).toEqual({ info: expect.objectContaining({ version: '0.2.0' }), stage: 'ready' })
    expect(await readdir(h.folder)).toEqual(['Cubex-Setup-0.2.0.exe'])
    expect(createHash('sha256').update(await readFile(join(h.folder, 'Cubex-Setup-0.2.0.exe'))).digest('hex')).toBe(SHA)
    // Each hop is requested by Cubex itself, so each can be checked before it is followed.
    expect(world.calls.slice(1)).toEqual([`manual ${ASSET}`, `manual ${CDN}`])
  })

  it('tells the window how far it got, no more than ten times a second, and ends at the full size', async () => {
    const h = harness()
    await h.service.checkNow(true)
    await h.service.download()
    const progress = h.pushed.filter((state) => state.update?.stage === 'downloading').map((state) => state.update?.progress)
    expect(progress[0]).toEqual({ received: 0, total: INSTALLER.length })
    for (const entry of progress) {
      expect(entry?.total).toBe(INSTALLER.length)
      expect(entry?.received).toBeLessThanOrEqual(INSTALLER.length)
    }
    const received = progress.map((entry) => entry?.received ?? 0)
    expect([...received].sort((a, b) => a - b)).toEqual(received)
    expect(received.at(-1)).toBe(INSTALLER.length)
    // The clock does not move, so after the first chunk only the reports that reach the full size pass the throttle.
    expect(progress.length).toBeLessThanOrEqual(6)
  })

  it('reports more often once time has passed between chunks', async () => {
    let tick = 0
    const h = harness({ now: () => (tick += 150) })
    await h.service.checkNow(true)
    tick = 0
    await h.service.download()
    const reports = h.pushed.filter((state) => state.update?.stage === 'downloading').length
    expect(reports).toBeGreaterThan(6)
  })

  it('goes on from what arrived when the connection is cut', async () => {
    let first = true
    world.installer = (init) => {
      const cut = first ? 120_000 : undefined
      first = false
      return installerResponse(init, INSTALLER, { cutAt: cut })
    }
    const h = harness()
    await h.service.checkNow(true)
    await h.service.download()
    expect(stage(h)).toBe('ready')
    // The second request asked only for the rest.
    expect(world.calls.filter((call) => call === `manual ${CDN}`)).toHaveLength(2)
  })

  it('says so when the connection keeps breaking before the end', async () => {
    world.installer = (init) => installerResponse(init, INSTALLER, { cutAt: 100_000 })
    const h = harness()
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update).toMatchObject({ stage: 'available', error: 'The download stopped before it finished. Check your connection and try again.' })
    expect((await readdir(h.folder)).some((name) => name === 'Cubex-Setup-0.2.0.exe')).toBe(false)
    // After three tries, not one.
    expect(world.calls.filter((call) => call === `manual ${CDN}`)).toHaveLength(3)
  })

  it('says so when the network is gone', async () => {
    const h = harness()
    await h.service.checkNow(true)
    world.installer = () => { throw new TypeError('fetch failed') }
    const state = await h.service.download()
    expect(state.update).toMatchObject({ stage: 'available', error: 'The download stopped before it finished. Check your connection and try again.' })
    expect((await readdir(h.folder)).some((name) => name.endsWith('.exe'))).toBe(false)
  })

  it('refuses a file that is not the one GitHub described, and deletes it', async () => {
    const wrong = Buffer.from(INSTALLER)
    wrong[1000] = wrong[1000]! ^ 0xff
    world.installer = (init) => installerResponse(init, wrong)
    const h = harness()
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update?.stage).toBe('available')
    expect(state.update?.error).toMatch(/did not match its checksum, so Cubex deleted it/)
    expect(await readdir(h.folder)).toEqual([])
  })

  it('logs a failure by its code, because the download library words its own messages for models', async () => {
    const wrong = Buffer.from(INSTALLER)
    wrong[1000] = wrong[1000]! ^ 0xff
    world.installer = (init) => installerResponse(init, wrong)
    const logged: string[] = []
    const h = harness({ log: (level, message, details) => { logged.push(`${level} ${message} ${JSON.stringify(details)}`) } })
    await h.service.checkNow(true)
    await h.service.download()
    const failure = logged.find((line) => line.includes('Update download failed'))
    expect(failure).toBe('warn Update download failed {"version":"0.2.0","code":"checksum"}')
    expect(logged.join('\n')).not.toMatch(/Hugging Face/)
  })

  it('says what happened when GitHub has no file', async () => {
    world.installer = () => new Response('Not Found', { status: 404 })
    const h = harness()
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update?.error).toBe('GitHub did not provide the installer. Try again later, or download it from the release page.')
    expect(state.update?.stage).toBe('available')
  })

  it('does not follow a redirect to a server of its own choosing', async () => {
    const hosts: string[] = []
    const base = fakeFetch(world)
    const h = harness({
      fetch: async (input, init) => {
        const url = String(input)
        hosts.push(new URL(url).host)
        if (url === ASSET) return new Response(null, { status: 302, headers: { location: 'https://evil.example/Cubex-Setup-0.2.0.exe' } })
        return base(input, init)
      }
    })
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update?.error).toMatch(/sent the download to a server Cubex does not use for updates/)
    expect(hosts).not.toContain('evil.example')
    expect(state.update?.stage).toBe('available')
  })

  it.each([
    ['plain http', 'http://release-assets.githubusercontent.com/x'],
    ['a look-alike host', 'https://github.com.evil.example/x'],
    ['another port', 'https://github.com:8443/x']
  ])('does not follow a redirect to %s', async (_name, location) => {
    const base = fakeFetch(world)
    const h = harness({ fetch: async (input, init) => (String(input) === ASSET ? new Response(null, { status: 302, headers: { location } }) : base(input, init)) })
    await h.service.checkNow(true)
    expect((await h.service.download()).update?.error).toMatch(/does not use for updates/)
  })

  it('gives up on a redirect that never ends', async () => {
    const base = fakeFetch(world)
    let hops = 0
    const h = harness({
      fetch: async (input, init) => {
        if (!String(input).startsWith('https://github.com/HeshamXOR/Cubex/releases/download')) return base(input, init)
        hops++
        return new Response(null, { status: 302, headers: { location: ASSET } })
      }
    })
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update).toMatchObject({ stage: 'available', error: 'The download stopped before it finished. Check your connection and try again.' })
    // Six requests make a chain, three tries make the most there will be.
    expect(hops).toBe(18)
  })

  it('takes the file that is already there when it is the right one', async () => {
    const first = await readyService()
    const second = harness({ directory: first.folder })
    await second.service.checkNow(true)
    const before = world.calls.length
    const state = await second.service.download()
    expect(state.update?.stage).toBe('ready')
    expect(world.calls.slice(before)).toEqual([])
  })

  it('replaces a file that is there but is not the right one', async () => {
    const h = harness()
    await mkdir(h.folder, { recursive: true })
    await writeFile(join(h.folder, 'Cubex-Setup-0.2.0.exe'), Buffer.alloc(INSTALLER.length, 1))
    await h.service.checkNow(true)
    expect((await h.service.download()).update?.stage).toBe('ready')
    expect(createHash('sha256').update(await readFile(join(h.folder, 'Cubex-Setup-0.2.0.exe'))).digest('hex')).toBe(SHA)
  })

  it('deletes the installers of other versions before it begins, and nothing else', async () => {
    const h = harness()
    await mkdir(h.folder, { recursive: true })
    for (const name of ['Cubex-Setup-0.1.5.exe', 'Cubex-Setup-0.1.5.exe.part', 'Cubex-Setup-0.1.5.exe.part.json', 'notes.txt', 'Cubex-Setup.exe.bak']) await writeFile(join(h.folder, name), 'x')
    await h.service.checkNow(true)
    await h.service.download()
    expect((await readdir(h.folder)).sort()).toEqual(['Cubex-Setup-0.2.0.exe', 'Cubex-Setup.exe.bak', 'notes.txt'])
  })

  it('is refused for a copy that cannot replace itself, with the reason', async () => {
    const reason = 'This copy was not set up with the Cubex installer, so it cannot update itself. Download the installer from the release page.'
    const h = harness({ support: { canInstall: false, reason } })
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update).toMatchObject({ stage: 'available', error: reason })
    expect(world.calls.filter((call) => call.includes('releases/download'))).toEqual([])
  })

  it('is refused for a release without a usable installer, with the reason', async () => {
    world.release = () => new Response(JSON.stringify(releaseJson('0.2.0', { digest: undefined })), { status: 200 })
    const h = harness()
    await h.service.checkNow(true)
    const state = await h.service.download()
    expect(state.update?.stage).toBe('available')
    expect(state.update?.error).toMatch(/no checksum, so Cubex will not install it for you/)
  })

  it('does nothing when there is nothing to download, or it already is', async () => {
    const h = harness()
    expect((await h.service.download()).update).toBeUndefined()
    await h.service.checkNow(true)
    await h.service.download()
    const calls = world.calls.length
    expect((await h.service.download()).update?.stage).toBe('ready')
    expect(world.calls).toHaveLength(calls)
  })

  it('does not start a second download while one runs', async () => {
    world.installer = (init) => installerResponse(init, INSTALLER, { hold: true })
    const h = harness()
    await h.service.checkNow(true)
    const first = h.service.download()
    await vi.waitFor(() => expect(h.service.getState().update?.progress?.received).toBeGreaterThan(0))
    const second = await h.service.download()
    expect(second.update?.stage).toBe('downloading')
    await h.service.cancelDownload()
    await first
    expect(world.calls.filter((call) => call === `manual ${ASSET}`)).toHaveLength(1)
  })

  describe('cancelling', () => {
    it('stops the download, goes back to offering it, and deletes what arrived', async () => {
      world.installer = (init) => installerResponse(init, INSTALLER, { hold: true })
      const h = harness()
      await h.service.checkNow(true)
      const job = h.service.download()
      await vi.waitFor(() => expect(h.service.getState().update?.progress?.received).toBeGreaterThan(0))
      const state = await h.service.cancelDownload()
      await job
      expect(state.update).toEqual({ info: expect.objectContaining({ version: '0.2.0' }), stage: 'available' })
      expect(state.update?.error).toBeUndefined()
      expect(await readdir(h.folder)).toEqual([])
    })

    it('does nothing when no download runs', async () => {
      const h = harness()
      expect((await h.service.cancelDownload()).update).toBeUndefined()
    })

    it('can be followed by a download from the start', async () => {
      world.installer = (init) => installerResponse(init, INSTALLER, { hold: true })
      const h = harness()
      await h.service.checkNow(true)
      const job = h.service.download()
      await vi.waitFor(() => expect(h.service.getState().update?.progress?.received).toBeGreaterThan(0))
      await h.service.cancelDownload()
      await job
      world.installer = (init) => installerResponse(init, INSTALLER)
      expect((await h.service.download()).update?.stage).toBe('ready')
    })
  })

  it('keeps what arrived when Cubex quits in the middle, so the next time goes on from there', async () => {
    world.installer = (init) => installerResponse(init, INSTALLER, { hold: true })
    const h = harness()
    await h.service.checkNow(true)
    const job = h.service.download()
    await vi.waitFor(() => expect(h.service.getState().update?.progress?.received).toBeGreaterThan(0))
    const pushes = h.pushed.length
    h.service.dispose()
    await job
    expect(h.pushed).toHaveLength(pushes)
    expect(await readdir(h.folder)).toContain('Cubex-Setup-0.2.0.exe.part')
  })

  it('keeps an update that is ready when a later look finds the same release', async () => {
    const h = await readyService()
    expect((await h.service.checkNow(true)).update?.stage).toBe('ready')
    expect((await h.service.install()).ok).toBe(true)
  })

  it('forgets a download when a newer release replaces the one it was for', async () => {
    const h = await readyService()
    world.release = () => new Response(JSON.stringify(releaseJson('0.3.0')), { status: 200 })
    const state = await h.service.checkNow(true)
    expect(state.update).toMatchObject({ stage: 'available', info: { version: '0.3.0' } })
    expect((await h.service.install()).ok).toBe(false)
  })
})

// --- Installing ---------------------------------------------------------------------------------

describe('installing', () => {
  it('starts the installer, and only then quits', async () => {
    const h = await readyService()
    const result = await h.service.install()
    expect(result).toEqual({ ok: true })
    expect(h.events).toEqual([`start ${join(h.folder, 'Cubex-Setup-0.2.0.exe')}`, 'quit'])
    expect(stage(h)).toBe('installing')
  })

  it('asks before it stops work that is running', async () => {
    const h = await readyService()
    world.busy = { turns: 2, tasks: 0 }
    expect(await h.service.install()).toEqual({ ok: false, reason: 'busy', busy: { turns: 2, tasks: 0 } })
    world.busy = { turns: 0, tasks: 1 }
    expect(await h.service.install({})).toEqual({ ok: false, reason: 'busy', busy: { turns: 0, tasks: 1 } })
    expect(h.events).toEqual([])
    expect(stage(h)).toBe('ready')
  })

  it('goes ahead when the person says to stop the work', async () => {
    const h = await readyService()
    world.busy = { turns: 1, tasks: 3 }
    expect(await h.service.install({ force: true })).toEqual({ ok: true })
    expect(h.events.at(-1)).toBe('quit')
  })

  it('stays open and says where the installer is when it cannot be started', async () => {
    const h = await readyService()
    world.startFails = true
    const result = await h.service.install()
    expect(result).toEqual({ ok: false, reason: 'failed', message: expect.stringContaining('could not start the installer (spawn UNKNOWN)') })
    expect(result.ok === false && result.reason === 'failed' && result.message).toContain(join(h.folder, 'Cubex-Setup-0.2.0.exe'))
    expect(h.events.some((event) => event === 'quit')).toBe(false)
    expect(h.service.getState().update).toMatchObject({ stage: 'ready', error: expect.stringContaining('Open ') })
    // The person can try again.
    world.startFails = false
    expect(await h.service.install()).toEqual({ ok: true })
  })

  it('does not run a file that changed after it was checked, and deletes it', async () => {
    const h = await readyService()
    const path = join(h.folder, 'Cubex-Setup-0.2.0.exe')
    const tampered = Buffer.from(INSTALLER)
    tampered[5] = tampered[5]! ^ 1
    await writeFile(path, tampered)
    const result = await h.service.install()
    expect(result).toEqual({ ok: false, reason: 'failed', message: expect.stringMatching(/changed after it was checked, so Cubex deleted it/) })
    expect(h.events).toEqual([])
    expect(await readdir(h.folder)).toEqual([])
    expect(h.service.getState().update).toMatchObject({ stage: 'available', error: expect.stringMatching(/Download it again/) })
  })

  it('does not run a file that is smaller or larger than it should be', async () => {
    const h = await readyService()
    await writeFile(join(h.folder, 'Cubex-Setup-0.2.0.exe'), Buffer.concat([INSTALLER, Buffer.from('x')]))
    expect((await h.service.install()).ok).toBe(false)
    expect(h.events).toEqual([])
  })

  it('says so when the file is gone', async () => {
    const h = await readyService()
    await rm(join(h.folder, 'Cubex-Setup-0.2.0.exe'))
    expect(await h.service.install()).toEqual({ ok: false, reason: 'failed', message: 'The downloaded installer is no longer there. Download it again.' })
    expect(stage(h)).toBe('available')
  })

  it('has nothing to run before a download, or twice', async () => {
    const h = harness()
    expect(await h.service.install()).toEqual({ ok: false, reason: 'failed', message: 'There is no downloaded update to install. Download it first.' })
    await h.service.checkNow(true)
    expect((await h.service.install()).ok).toBe(false)
    const ready = await readyService()
    expect(await ready.service.install()).toEqual({ ok: true })
    expect((await ready.service.install()).ok).toBe(false)
    expect(ready.events.filter((event) => event === 'quit')).toHaveLength(1)
  })

  it('is not done by a copy that cannot update itself, because it never gets a download', async () => {
    const h = harness({ support: { canInstall: false, reason: 'x' } })
    await h.service.checkNow(true)
    await h.service.download()
    expect((await h.service.install()).ok).toBe(false)
    expect(h.events).toEqual([])
  })

  it('does not check while it installs', async () => {
    const h = await readyService()
    await h.service.install()
    const before = world.calls.length
    expect((await h.service.checkNow(true)).update?.stage).toBe('installing')
    expect(world.calls).toHaveLength(before)
  })
})

describe('the release page', () => {
  it('opens the page of the release on offer, an address the service parsed itself', async () => {
    const h = harness()
    await h.service.checkNow(true)
    await h.service.openReleasePage()
    expect(h.events).toEqual([`open ${PAGE}`])
  })

  it('opens the list of releases when nothing is on offer', async () => {
    const h = harness()
    await h.service.openReleasePage()
    expect(h.events).toEqual(['open https://github.com/HeshamXOR/Cubex/releases'])
  })
})
