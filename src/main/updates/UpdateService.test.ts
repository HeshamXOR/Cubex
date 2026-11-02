import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateBusy, UpdateState } from '@shared/updates'
import { GITHUB_FEED } from './feed'
import { LOCAL_ONLY_DOWNLOAD_MESSAGE, UpdateService, type UpdateServiceOptions } from './UpdateService'

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
})

describe('local-only mode', () => {

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
})

describe('skipping', () => {
  it('is remembered, and the release stays known but not announced', async () => {
    const h = harness()
    await h.service.checkNow(true)
    const state = h.service.skip('0.2.0')
    expect(h.events).toEqual(['skip 0.2.0'])
    expect(state.update).toMatchObject({ stage: 'available', skipped: true })
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
})
